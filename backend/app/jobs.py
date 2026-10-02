"""Background processing: OCR every uploaded document, then parse into questions."""

from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

from .config import Settings
from .models import DocKind, DocumentResult, Project, ProjectStats
from .store import Store

log = logging.getLogger(__name__)

# Issues meaning the offline pass broke a question's structure (worth an AI re-read).
STRUCTURAL_CODES = {"option_count", "empty_option", "empty_stem", "merged_suspect"}
MAX_REPAIRS = 30


class JobRunner:
    def __init__(self, store: Store, settings: Settings) -> None:
        self.store = store
        self.settings = settings
        self.pool = ThreadPoolExecutor(
            max_workers=max(1, settings.workers), thread_name_prefix="job"
        )
        self._queue_lock = threading.Lock()
        self._queued: list[str] = []  # FIFO of submitted, not yet started projects
        self._running: set[str] = set()

    def submit(self, project_id: str) -> None:
        with self._queue_lock:
            if project_id in self._queued or project_id in self._running:
                return
            self._queued.append(project_id)
        self.pool.submit(self._run_tracked, project_id)

    def queue_state(self) -> dict:
        with self._queue_lock:
            return {"running": sorted(self._running), "queued": list(self._queued)}

    def queue_position(self, project_id: str) -> int | None:
        with self._queue_lock:
            return self._queued.index(project_id) + 1 if project_id in self._queued else None

    def _run_tracked(self, project_id: str) -> None:
        with self._queue_lock:
            if project_id in self._queued:
                self._queued.remove(project_id)
            self._running.add(project_id)
        try:
            self._run(project_id)
        finally:
            with self._queue_lock:
                self._running.discard(project_id)

    def resume_pending(self) -> None:
        """Re-queue projects interrupted by a restart."""
        for project in self.store.list():
            if project.status in ("queued", "processing"):
                self.submit(project.id)

    def shutdown(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------------ worker

    def _update(self, project_id: str, **changes) -> Project:
        with self.store.lock(project_id):
            project = self.store.load(project_id)
            for key, value in changes.items():
                setattr(project, key, value)
            self.store.save(project)
            return project

    def _run(self, project_id: str) -> None:
        # heavy imports (cv2, pymupdf) stay lazy
        from .pipeline import AiBudget, process_document

        try:
            project = self.store.load(project_id)
            total = sum(d.page_count for d in project.documents)
            done_before = 0
            started = time.monotonic()
            stats = ProjectStats(pages=total, started_at=datetime.now(UTC))
            self._set_progress(project_id, "ocr", 0, total, status="processing", stats=stats)
            engines: set[str] = set()
            # one AI budget per project, shared by its documents and the repair pass
            budget = AiBudget(self.settings.ai_max_calls_per_project)
            out_dir = self.store.pages_dir(project_id)
            out_dir.mkdir(parents=True, exist_ok=True)

            for info in project.documents:
                offset = done_before

                def on_progress(done: int, _total: int, offset: int = offset) -> None:
                    self._set_progress(project_id, "ocr", offset + done, total)

                doc = process_document(
                    self.store.load_upload(project_id, info.kind),
                    info.kind,
                    info.filename,
                    project.engine,
                    self._settings_for_run(),
                    out_dir,
                    on_progress,
                    budget=budget,
                )
                self.store.save_document(project_id, doc)
                done_before += info.page_count
                for page in doc.pages:
                    engines.add(page.engine)
                    stats.ai_pages += page.ai_mode != "none"
                    stats.ai_usage.add(page.ai_usage)

            stats.ai_cost_usd = ai_cost(stats.ai_usage, project.engine, self.settings)
            stats.ocr_seconds = round(time.monotonic() - started, 1)
            stats.engine = " / ".join(sorted(engines))
            self._set_progress(project_id, "parsing", total, total, stats=stats)
            parse_started = time.monotonic()
            self.parse(project_id, after_ocr=True, budget=budget)
            with self.store.lock(project_id):
                project = self.store.load(project_id)
                project.stats.parse_seconds = round(time.monotonic() - parse_started, 1)
                project.stats.finished_at = datetime.now(UTC)
                self.store.save(project)
        except Exception as exc:  # report any failure on the project instead of losing it
            log.exception("processing failed for %s", project_id)
            with self.store.lock(project_id):
                project = self.store.load(project_id)
                project.status = "failed"
                project.progress.stage = "failed"
                project.error = f"پردازش ناموفق بود: {exc}"
                self.store.save(project)

    def _settings_for_run(self) -> Settings:
        """Share the CPU cores between the documents being processed right now."""
        if self.settings.page_workers > 0:
            return self.settings
        with self._queue_lock:
            running = max(1, len(self._running))
        cores = max(1, (os.cpu_count() or 2) // running)
        return self.settings.model_copy(update={"page_workers": cores})

    def _set_progress(self, project_id: str, stage: str, done: int, total: int, **extra) -> None:
        with self.store.lock(project_id):
            project = self.store.load(project_id)
            project.progress.stage = stage
            project.progress.done = done
            project.progress.total = total
            for key, value in extra.items():
                setattr(project, key, value)
            self.store.save(project)

    def parse(
        self,
        project_id: str,
        blueprint: str | None = None,
        *,
        after_ocr: bool = False,
        budget=None,
    ) -> Project:
        """(Re)build questions from the stored OCR results.

        After OCR, duplicates are detected and — when the project asks for it —
        clean questions are approved automatically.
        """
        from .parser import build_questions
        from .review import auto_approve, detect_duplicates, revalidate

        booklet = self.store.load_document(project_id, "booklet")
        if booklet is None:
            raise RuntimeError("نتیجه‌ی OCR دفترچه پیدا نشد.")
        explanations = self.load_doc(project_id, "explanations")
        with self.store.lock(project_id):
            project = self.store.load(project_id)
            if blueprint:
                project.blueprint = blueprint
            result = build_questions(
                booklet, explanations, project.blueprint, default_subject=project.default_subject
            )
            project.questions = result.questions
            project.issues = result.issues
            if project.doc_type == "auto":
                project.mode = _detect_mode(result)
            else:
                project.mode = project.doc_type
            if after_ocr and project.engine == "auto" and project.mode == "questions":
                self._repair_broken_questions(project, budget)
            detect_duplicates(project, self.store)
            revalidate(project)
            if after_ocr and project.auto_approve:
                auto_approve(project)
            project.status = "ready"
            project.error = None
            project.progress.stage = "done"
            self.store.save(project)
            return project

    def _repair_broken_questions(self, project: Project, budget) -> None:
        """Smart mode, last resort: re-read with the AI only the questions whose structure
        the offline pass broke (missing options / stem), and only their region."""
        from .ocr.llm import AiEngineError
        from .parser import parse_single_question
        from .pipeline import reocr_region_ex, resolve_engine
        from .validate import validate_question

        if resolve_engine("auto", self.settings) is None:
            return
        booklet = self.store.load_document(project.id, "booklet")
        transcribed = {
            p.index for p in (booklet.pages if booklet else []) if p.ai_mode == "transcribe"
        }
        has_expl = any(d.kind == "explanations" for d in project.documents)
        repaired = 0
        for question in project.questions:
            if repaired >= MAX_REPAIRS:
                break
            codes = {i.code for i in validate_question(question, has_expl)}
            regions = [r for r in question.regions if r.doc == "booklet"]
            if not (codes & STRUCTURAL_CODES) or not regions:
                continue
            if all(r.page in transcribed for r in regions):
                continue  # the AI already read these pages in full
            lines = []
            try:
                for region in regions:
                    image = self.store.page_image(project.id, "booklet", region.page)
                    region_lines, usage = reocr_region_ex(
                        image, region.bbox, "auto", self.settings, region.page, budget
                    )
                    project.stats.ai_usage.add(usage)
                    lines.extend(region_lines)
            except AiEngineError as exc:
                log.warning("AI repair of question %s failed: %s", question.number, exc)
                continue
            parsed = parse_single_question(lines, "booklet") if lines else None
            if parsed is None:
                continue
            filled = [o for o in parsed.options if o.text.strip()]
            if parsed.stem.strip() and len(filled) == 4:
                question.stem = parsed.stem
                question.options = parsed.options
                question.flags = [f for f in question.flags if f.doc != "booklet"] + parsed.flags
                if parsed.correct_key and not question.correct_key:
                    question.correct_key = parsed.correct_key
                    question.key_source = parsed.key_source
                repaired += 1
        if repaired:
            log.info("AI repaired %d questions in %s", repaired, project.id)
        project.stats.ai_cost_usd = ai_cost(project.stats.ai_usage, project.engine, self.settings)

    def load_doc(self, project_id: str, kind: DocKind) -> DocumentResult | None:
        return self.store.load_document(project_id, kind)


def ai_cost(usage, engine: str, settings: Settings) -> float:
    """USD estimate from the configured per-million-token prices."""
    provider = settings.default_ai_engine if engine in ("auto", "offline") else engine
    if provider == "gemini":
        price_in, price_out = settings.gemini_price_in, settings.gemini_price_out
    else:
        price_in, price_out = settings.claude_price_in, settings.claude_price_out
    cost = (usage.input_tokens * price_in + usage.output_tokens * price_out) / 1_000_000
    return round(cost, 4)


def _detect_mode(result) -> str:
    try:
        from .parser import detect_mode
    except ImportError:  # older parser: questions if anything well-formed was found
        good = [q for q in result.questions if sum(bool(o.text) for o in q.options) >= 2]
        return "questions" if len(good) >= 3 else "text"
    return detect_mode(result)
