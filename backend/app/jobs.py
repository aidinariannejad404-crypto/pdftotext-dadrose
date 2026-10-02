"""Background processing: OCR every uploaded document, then parse into questions."""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor

from .config import Settings
from .models import DocKind, DocumentResult, Project
from .store import Store

log = logging.getLogger(__name__)


class JobRunner:
    def __init__(self, store: Store, settings: Settings) -> None:
        self.store = store
        self.settings = settings
        self.pool = ThreadPoolExecutor(
            max_workers=max(1, settings.workers), thread_name_prefix="job"
        )

    def submit(self, project_id: str) -> None:
        self.pool.submit(self._run, project_id)

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
        from .pipeline import process_document  # heavy imports (cv2, pymupdf) stay lazy

        try:
            project = self.store.load(project_id)
            total = sum(d.page_count for d in project.documents)
            done_before = 0
            self._set_progress(project_id, "ocr", 0, total, status="processing")
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
                    self.settings,
                    out_dir,
                    on_progress,
                )
                self.store.save_document(project_id, doc)
                done_before += info.page_count

            self._set_progress(project_id, "parsing", total, total)
            self.parse(project_id)
        except Exception as exc:  # report any failure on the project instead of losing it
            log.exception("processing failed for %s", project_id)
            with self.store.lock(project_id):
                project = self.store.load(project_id)
                project.status = "failed"
                project.progress.stage = "failed"
                project.error = f"پردازش ناموفق بود: {exc}"
                self.store.save(project)

    def _set_progress(self, project_id: str, stage: str, done: int, total: int, **extra) -> None:
        with self.store.lock(project_id):
            project = self.store.load(project_id)
            project.progress.stage = stage
            project.progress.done = done
            project.progress.total = total
            for key, value in extra.items():
                setattr(project, key, value)
            self.store.save(project)

    def parse(self, project_id: str, blueprint: str | None = None) -> Project:
        """(Re)build questions from the stored OCR results."""
        from .parser import build_questions

        booklet = self.store.load_document(project_id, "booklet")
        if booklet is None:
            raise RuntimeError("نتیجه‌ی OCR دفترچه پیدا نشد.")
        explanations = self.load_doc(project_id, "explanations")
        with self.store.lock(project_id):
            project = self.store.load(project_id)
            if blueprint:
                project.blueprint = blueprint
            result = build_questions(booklet, explanations, project.blueprint)
            project.questions = result.questions
            project.issues = result.issues
            if project.doc_type == "auto":
                project.mode = _detect_mode(result)
            else:
                project.mode = project.doc_type
            project.status = "ready"
            project.error = None
            project.progress.stage = "done"
            self.store.save(project)
            return project

    def load_doc(self, project_id: str, kind: DocKind) -> DocumentResult | None:
        return self.store.load_document(project_id, kind)


def _detect_mode(result) -> str:
    try:
        from .parser import detect_mode
    except ImportError:  # older parser: questions if anything well-formed was found
        good = [q for q in result.questions if sum(bool(o.text) for o in q.options) >= 2]
        return "questions" if len(good) >= 3 else "text"
    return detect_mode(result)
