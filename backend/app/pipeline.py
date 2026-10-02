"""Document OCR pipeline: PDF → per-page lines.

Two phases:

1. offline, every page: text layer, or preprocess + Tesseract; then document-level flag
   refinement and a quality score per OCR page;
2. AI, only where needed. Engine semantics:
   * "offline" — never;
   * "claude" / "gemini" — always: every OCR page is fully transcribed (max quality);
   * "auto" — smart (token-frugal): pages below `settings.page_ai_threshold` are fully
     transcribed; better pages with flagged words send only those lines (plus one line of
     context each side) as a stacked crop for word-level correction; clean pages use no AI.

AI answers are cached on disk (`ai_cache`), every call is budgeted per project
(`AiBudget`) and its token usage is recorded on the page (`PageResult.ai_usage`).
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pymupdf

from app.config import Settings
from app.models import AiUsage, BBox, DocumentResult, Line, PageResult, Word
from app.ocr import consensus
from app.ocr.ai_cache import AiCache, cache_key
from app.ocr.consensus import comparable
from app.ocr.flags import refine_low_conf_flags
from app.ocr.llm import (
    PROMPT_VERSION,
    AiEngine,
    AiEngineError,
    AiResult,
    correction_prompt,
    get_ai_engine,
    user_prompt,
)
from app.ocr.quality import BLANK_INK, ink_ratio, page_quality
from app.ocr.tesseract import ocr_tesseract
from app.pdf_input import RenderedPage, render_document
from app.preprocess import preprocess

log = logging.getLogger(__name__)

UI_MAX_SIDE = 2400  # stored page images (AI images are cut from these)
AI_MAX_SIDE = 1568  # Claude downsizes anything larger anyway; fewer pixels = fewer tokens
AI_JPEG_QUALITY = 80
AI_WORKERS = 4
REGION_MARGIN = 0.01  # normalized margin added around a re-OCR region
MAX_CROPS = 6  # correction bands per page (stacked into one image → still one call)
BUDGET_WARNING = "سقف استفاده از هوش مصنوعی برای این پروژه پر شد"


# ----------------------------------------------------------------------------- budget


class AiBudget:
    """Thread-safe cap on AI calls for one project (cache hits are free and not counted)."""

    def __init__(self, max_calls: int) -> None:
        self.max_calls = max_calls
        self.used = 0
        self._lock = threading.Lock()

    def take(self) -> bool:
        with self._lock:
            if self.used >= self.max_calls:
                return False
            self.used += 1
            return True

    @property
    def exhausted(self) -> bool:
        with self._lock:
            return self.used >= self.max_calls


class AiCaller:
    """An engine wrapped with the disk cache, the budget and usage accounting.
    Methods return None when the budget is exhausted (no call made)."""

    def __init__(self, engine: AiEngine, budget: AiBudget | None, cache: AiCache | None) -> None:
        self.engine, self.budget, self.cache = engine, budget, cache

    @property
    def name(self) -> str:
        return self.engine.name

    def _run(self, mode: str, jpeg: bytes, text: str, call: Callable[[], AiResult]):
        key = None
        if self.cache is not None:
            model = getattr(self.engine, "model", "")
            key = cache_key(self.engine.name, model, mode, PROMPT_VERSION, jpeg, text)
            hit = self.cache.get(key)
            if hit is not None:
                return AiResult.from_cache(hit)
        if self.budget is not None and not self.budget.take():
            return None
        result = call()
        if key is not None and result.complete:
            self.cache.put(key, result.to_cache())  # type: ignore[union-attr]
        return result

    def transcribe(self, jpeg: bytes, mode: str = "page") -> AiResult | None:
        return self._run(
            mode, jpeg, user_prompt(mode), lambda: self.engine.transcribe_ex(jpeg, mode)
        )  # type: ignore[arg-type]

    def correct(self, jpeg: bytes, lines: list[str]) -> AiResult | None:
        return self._run(
            "correct", jpeg, correction_prompt(lines), lambda: self.engine.correct(jpeg, lines)
        )


def resolve_engine(engine: str, settings: Settings) -> AiEngine | None:
    """The AI engine to use for `engine` ("auto" → settings.default_ai_engine if configured)."""
    if engine == "offline":
        return None
    name = settings.default_ai_engine if engine == "auto" else engine
    return get_ai_engine(name, settings)


# ---------------------------------------------------------------------------- images


def _resize_max(img: np.ndarray, max_side: int) -> np.ndarray:
    h, w = img.shape[:2]
    s = max_side / max(h, w)
    if s >= 1:
        return img
    return cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)


def _jpeg(img: np.ndarray, quality: int = 85) -> bytes:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("JPEG encoding failed")
    return buf.tobytes()


def ai_jpeg(img: np.ndarray) -> bytes:
    """Grayscale JPEG (q80, long side ≤ 1568 px): what every AI call receives."""
    if img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return _jpeg(_resize_max(img, AI_MAX_SIDE), AI_JPEG_QUALITY)


def _save_jpeg(path: Path, img: np.ndarray, quality: int = 85) -> None:
    path.write_bytes(_jpeg(_resize_max(img, UI_MAX_SIDE), quality))


# ------------------------------------------------------------------------ phase 1


@dataclass
class _Offline:
    page: PageResult
    image_path: Path  # processed page image (what the AI sees)
    ink: float | None = None

    @property
    def blank(self) -> bool:
        return self.ink is not None and self.ink < BLANK_INK


def _offline_page(rp: RenderedPage, kind: str, settings: Settings, out_dir: Path) -> _Offline:
    orig_path = out_dir / f"{kind}-{rp.index}-orig.jpg"
    proc_path = out_dir / f"{kind}-{rp.index}.jpg"
    _save_jpeg(orig_path, rp.image_bgr)

    if rp.text_lines is not None:
        _save_jpeg(proc_path, rp.image_bgr)
        h, w = rp.image_bgr.shape[:2]
        page = PageResult(
            index=rp.index,
            width=w,
            height=h,
            source="text_layer",
            engine="text_layer",
            lines=rp.text_lines,
        )
        return _Offline(page, proc_path)

    gray, steps = preprocess(rp.image_bgr, settings.tesseract_cmd, settings.tessdata_dir)
    _save_jpeg(proc_path, gray)
    h, w = gray.shape[:2]
    ink = ink_ratio(gray)
    warnings: list[str] = []
    lines: list[Line] = []
    if ink >= BLANK_INK:  # Tesseract "reads" noise on blank sheets; don't let it
        try:
            lines = ocr_tesseract(gray, rp.index, settings)
        except Exception as exc:
            log.exception("tesseract failed on page %s", rp.index)
            warnings.append(f"Tesseract روی این صفحه خطا داد: {exc}")
    page = PageResult(
        index=rp.index,
        width=w,
        height=h,
        source="ocr",
        engine="tesseract",
        preprocess=steps,
        lines=lines,
        warnings=warnings,
    )
    return _Offline(page, proc_path, ink)


# ------------------------------------------------------------------------ phase 2


def decide_ai_mode(page: PageResult, policy: str, threshold: float, blank: bool = False) -> str:
    """ "none" | "correct" | "transcribe" for an offline-read page under `policy`
    ("smart" | "always" | "never")."""
    if page.source != "ocr" or policy == "never" or blank:
        return "none"
    if policy == "always":
        return "transcribe"
    if page.quality is not None and page.quality < threshold:
        return "transcribe"
    if any(w.flag is not None for ln in page.lines for w in ln.words):
        return "correct"
    return "none"


@dataclass
class CorrectionRequest:
    jpeg: bytes
    lines: list[str]  # "index: text" with ⟦flagged⟧ words
    sent: set[int]  # page line indices included


def _band_groups(boxes: dict[int, BBox], max_groups: int) -> list[tuple[float, float]]:
    """Merge the selected lines' vertical extents into ≤ max_groups bands."""
    spans = sorted((b[1], b[3]) for b in boxes.values())
    bands: list[list[float]] = []
    for y0, y1 in spans:
        if bands and y0 - bands[-1][1] < 0.02:  # touching / nearly touching lines
            bands[-1][1] = max(bands[-1][1], y1)
        else:
            bands.append([y0, y1])
    while len(bands) > max_groups:
        gaps = [bands[i + 1][0] - bands[i][1] for i in range(len(bands) - 1)]
        i = int(np.argmin(gaps))
        bands[i] = [bands[i][0], max(bands[i][1], bands[i + 1][1])]
        del bands[i + 1]
    return [(a, b) for a, b in bands]


def build_correction_request(page: PageResult, img: np.ndarray) -> CorrectionRequest | None:
    """Crop the lines that contain flagged words and stack the crops into one image.

    Token choices: one stacked image per page instead of one call per crop (system prompt
    and instructions are paid once; image tokens scale with area either way), so up to
    MAX_CROPS bands are allowed — more, tighter bands mean less image area. Neighbour lines
    (±1) are sent as *text only* context (`i~ text`): ~30 text tokens instead of ~85 image
    tokens per line, and they cannot be corrected."""
    flagged = [
        i
        for i, ln in enumerate(page.lines)
        if ln.bbox is not None and any(w.flag for w in ln.words)
    ]
    if not flagged:
        return None
    n = len(page.lines)
    context = sorted({j for i in flagged for j in (i - 1, i + 1) if 0 <= j < n} - set(flagged))
    boxes = {i: page.lines[i].bbox for i in flagged}
    h, w = img.shape[:2]
    x0 = max(0.0, min(b[0] for b in boxes.values()) - 0.01)
    x1 = min(1.0, max(b[2] for b in boxes.values()) + 0.01)
    crops = []
    for y0, y1 in _band_groups(boxes, MAX_CROPS):  # type: ignore[arg-type]
        py0, py1 = int(max(0.0, y0 - 0.005) * h), int(np.ceil(min(1.0, y1 + 0.005) * h))
        crops.append(img[py0:py1, int(x0 * w) : int(np.ceil(x1 * w))])
    if sum(c.shape[0] for c in crops) > 0.8 * h:
        stacked = img  # almost the whole page anyway
    else:
        bar = np.full((8, crops[0].shape[1]), 150, np.uint8)
        parts: list[np.ndarray] = []
        for c in crops:
            if parts:
                parts.append(bar)
            parts.append(c)
        stacked = np.vstack(parts)
    texts = []
    for i in sorted(set(flagged) | set(context)):
        words = page.lines[i].words
        if i in boxes:
            texts.append(f"{i}: " + " ".join(f"⟦{w.text}⟧" if w.flag else w.text for w in words))
        else:
            texts.append(f"{i}~ " + " ".join(w.text for w in words))
    return CorrectionRequest(ai_jpeg(stacked), texts, set(flagged))


def _split_box(box: BBox | None, n: int) -> list[BBox | None]:
    if box is None or n <= 1:
        return [box] * n
    x0, y0, x1, y1 = box
    step = (x1 - x0) / n
    return [(x1 - (i + 1) * step, y0, x1 - i * step, y1) for i in range(n)]  # RTL


def _union(boxes: list[BBox | None]) -> BBox | None:
    bs = [b for b in boxes if b is not None]
    if not bs:
        return None
    return (
        min(b[0] for b in bs),
        min(b[1] for b in bs),
        max(b[2] for b in bs),
        max(b[3] for b in bs),
    )


def _find_words(words: list[Word], key: str) -> tuple[int, int] | None:
    """(start, size) of 1–3 consecutive words whose joined comparable form equals `key`;
    a flagged occurrence wins when the word appears more than once."""
    for size in (1, 2, 3):
        hits = [
            k
            for k in range(len(words) - size + 1)
            if comparable("".join(w.text for w in words[k : k + size])) == key
        ]
        if hits:
            flagged = [k for k in hits if any(w.flag for w in words[k : k + size])]
            return (flagged or hits)[0], size
    return None


def apply_corrections(page: PageResult, result: AiResult, sent: set[int]) -> int:
    """Apply word-level corrections in place; returns how many were applied.

    A correction is applied only when its line was sent and its `from` matches 1–3
    consecutive words of that line (compared Persian-aware: ZWNJ/space, ی/ي, digits,
    punctuation). The new word keeps the original reading in `alt` and loses its flag.
    Flagged words of lines the AI explicitly checked are cleared too (verified)."""
    applied = 0
    for corr in result.corrections:
        i = corr.get("line")
        if not isinstance(i, int) or i not in sent or i >= len(page.lines):
            continue
        src = corr["from"].replace("⟦", "").replace("⟧", "").strip()
        dst = corr["to"].replace("⟦", "").replace("⟧", "").strip()
        src_key = comparable(src.replace(" ", ""))
        if not src_key or not dst or comparable(dst.replace(" ", "")) == src_key:
            continue
        dst_tokens = dst.split()
        if len(dst_tokens) > len(src.split()) + 2:  # a rewrite, not a word fix
            continue
        words = page.lines[i].words
        match = _find_words(words, src_key)
        if match is None:
            continue
        k, size = match
        old = words[k : k + size]
        boxes = _split_box(_union([w.bbox for w in old]), len(dst_tokens))
        conf = min((w.conf for w in old if w.conf is not None), default=None)
        alt = " ".join(w.text for w in old)
        new = [
            Word(text=t, bbox=b, conf=conf, flag=None, alt=alt)
            for t, b in zip(dst_tokens, boxes, strict=True)
        ]
        words[k : k + size] = new
        applied += 1
    for i in set(result.checked) & sent:
        if i < len(page.lines):
            for w in page.lines[i].words:
                if w.flag == "low_conf":
                    w.flag = None
    for i in sent:
        ln = page.lines[i] if i < len(page.lines) else None
        if ln is not None:
            ln.bbox = _union([w.bbox for w in ln.words]) or ln.bbox
    return applied


def _ai_page(off: _Offline, mode: str, caller: AiCaller, threshold: float) -> None:
    """Phase 2 for one page (in place)."""
    page = off.page
    if mode == "none":
        return
    img = cv2.imread(str(off.image_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        page.warnings.append("تصویر صفحه برای ارسال به هوش مصنوعی پیدا نشد.")
        return
    try:
        if mode == "transcribe":
            res = caller.transcribe(ai_jpeg(img), "page")
            if res is None:
                page.warnings.append(BUDGET_WARNING)
                return
            page.ai_usage.add(res.usage)
            trust = page.quality is not None and page.quality < threshold
            lines, warnings = consensus.merge(res.text, page.lines, page.index, trust_ai=trust)
            page.warnings += warnings
            page.ai_mode = "transcribe"
            if lines is not page.lines:
                page.lines = lines
                page.engine = f"{caller.name}+tesseract"
        else:
            req = build_correction_request(page, img)
            if req is None:
                return
            res = caller.correct(req.jpeg, req.lines)
            if res is None:
                page.warnings.append(BUDGET_WARNING)
                return
            page.ai_usage.add(res.usage)
            apply_corrections(page, res, req.sent)
            page.ai_mode = "correct"
            page.engine = f"tesseract+{caller.name}"
    except AiEngineError as exc:
        page.warnings.append(
            f"خواندن با {caller.name} ناموفق بود: {exc} — نتیجه‌ی Tesseract استفاده شد."
        )
    except Exception as exc:  # never fail the whole document because of one AI call
        log.exception("AI engine %s failed", caller.name)
        page.warnings.append(
            f"خطای غیرمنتظره در {caller.name}: {exc} — نتیجه‌ی Tesseract استفاده شد."
        )


# ------------------------------------------------------------------------- document


def page_workers(settings: Settings, uses_ai: bool) -> int:
    """Pages processed in parallel inside one document.

    Tesseract runs single-threaded (OMP_THREAD_LIMIT=1), so CPU-bound pages scale with the
    cores left after the parallel documents (`workers`); AI calls are network-bound.
    """
    if settings.page_workers > 0:
        return settings.page_workers
    cpu_share = max(1, (os.cpu_count() or 2) // max(1, settings.workers))
    return max(AI_WORKERS, cpu_share) if uses_ai else cpu_share


def process_document(
    pdf_bytes: bytes,
    kind: str,
    filename: str,
    engine: str,
    settings: Settings,
    out_dir: Path,
    on_progress: Callable[[int, int], None] | None = None,
    budget: AiBudget | None = None,
) -> DocumentResult:
    out_dir.mkdir(parents=True, exist_ok=True)
    ai = resolve_engine(engine, settings)
    policy = "never" if ai is None else ("smart" if engine == "auto" else "always")
    missing_engine_warning = (
        f"موتور {engine} پیکربندی نشده است؛ فقط Tesseract استفاده شد."
        if ai is None and engine in ("claude", "gemini")
        else None
    )
    caller = (
        AiCaller(
            ai,
            budget if budget is not None else AiBudget(settings.ai_max_calls_per_project),
            AiCache.from_settings(settings),
        )
        if ai is not None
        else None
    )

    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
        total = doc.page_count
    # Progress: two units per page (offline + AI phase), reported as whole pages.
    units = 0
    lock = threading.Lock()

    def advance(n: int = 1) -> None:
        nonlocal units
        with lock:
            units += n
            if on_progress:
                on_progress(min(total, units // 2), total)

    if on_progress:
        on_progress(0, total)

    def offline(rp: RenderedPage) -> _Offline:
        try:
            return _offline_page(rp, kind, settings, out_dir)
        finally:
            advance()

    # Phase 1. Rendering is sequential (bounded memory); OCR runs in a CPU-sized pool.
    workers = page_workers(settings, uses_ai=False)
    results: list[_Offline] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = []
        for rp in render_document(pdf_bytes, settings.render_dpi):
            pending.append(pool.submit(offline, rp))
            if len(pending) >= workers * 2:
                results.append(pending.pop(0).result())
        results.extend(f.result() for f in pending)
    results.sort(key=lambda o: o.page.index)
    doc = DocumentResult(kind=kind, filename=filename, pages=[o.page for o in results])  # type: ignore[arg-type]
    refine_low_conf_flags(doc)

    modes: list[str] = []
    for off in results:
        if off.page.source == "ocr":
            off.page.quality = page_quality(off.page, off.ink)
            if missing_engine_warning:
                off.page.warnings.insert(0, missing_engine_warning)
        modes.append(decide_ai_mode(off.page, policy, settings.page_ai_threshold, off.blank))

    # Phase 2: network-bound AI calls in a small pool.
    def ai_work(off: _Offline, mode: str) -> None:
        try:
            if caller is not None:
                _ai_page(off, mode, caller, settings.page_ai_threshold)
        finally:
            advance()

    with ThreadPoolExecutor(max_workers=page_workers(settings, uses_ai=True)) as pool:
        list(pool.map(ai_work, results, modes))
    return doc


# --------------------------------------------------------------------------- region re-OCR


def _map_back(lines: list[Line], crop: BBox) -> list[Line]:
    cx0, cy0, cx1, cy1 = crop
    cw, ch = cx1 - cx0, cy1 - cy0

    def m(b: BBox | None) -> BBox | None:
        if b is None:
            return None
        return (cx0 + b[0] * cw, cy0 + b[1] * ch, cx0 + b[2] * cw, cy0 + b[3] * ch)

    out = []
    for ln in lines:
        words = [Word(**{**w.model_dump(), "bbox": m(w.bbox)}) for w in ln.words]
        out.append(Line(page=ln.page, words=words, bbox=m(ln.bbox)))
    return out


def reocr_region_ex(
    image_path: Path,
    bbox: BBox,
    engine: str,
    settings: Settings,
    page: int = 0,
    budget: AiBudget | None = None,
) -> tuple[list[Line], AiUsage]:
    """Re-read one region of a stored processed page image. `bbox` is normalized on that
    image; returned lines have full-page normalized bboxes. Also returns the AI usage."""
    usage = AiUsage()
    img = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise FileNotFoundError(image_path)
    h, w = img.shape
    x0 = max(0.0, bbox[0] - REGION_MARGIN)
    y0 = max(0.0, bbox[1] - REGION_MARGIN)
    x1 = min(1.0, bbox[2] + REGION_MARGIN)
    y1 = min(1.0, bbox[3] + REGION_MARGIN)
    px0, py0, px1, py1 = int(x0 * w), int(y0 * h), int(np.ceil(x1 * w)), int(np.ceil(y1 * h))
    crop = img[py0:py1, px0:px1]
    if crop.size == 0:
        return [], usage
    crop_box = (px0 / w, py0 / h, px1 / w, py1 / h)
    ai_image = ai_jpeg(crop)  # native resolution of the stored page, capped at 1568 px
    # Stored images are downscaled for the UI; give Tesseract enough pixels again.
    if crop.shape[1] < 1600:
        crop = cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)

    tess = ocr_tesseract(crop, page, settings, psm=6)
    ai = resolve_engine(engine, settings)
    if ai is None and engine in ("claude", "gemini"):
        raise AiEngineError(f"موتور {engine} پیکربندی نشده است (کلید API تنظیم نشده).")
    lines = tess
    if ai is not None:
        caller = AiCaller(ai, budget, AiCache.from_settings(settings))
        try:
            res = caller.transcribe(ai_image, "region")
            if res is None:
                raise AiEngineError(BUDGET_WARNING)
            usage.add(res.usage)
            lines, _ = consensus.merge(res.text, tess, page)
        except AiEngineError:
            if engine != "auto":
                raise
    return _map_back(lines, crop_box), usage


def reocr_region(
    image_path: Path, bbox: BBox, engine: str, settings: Settings, page: int = 0
) -> list[Line]:
    """Compatibility wrapper of `reocr_region_ex` returning only the lines."""
    return reocr_region_ex(image_path, bbox, engine, settings, page)[0]
