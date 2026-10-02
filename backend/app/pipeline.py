"""Document OCR pipeline: PDF → per-page lines (text layer, or preprocess + Tesseract + AI)."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
import pymupdf

from app.config import Settings
from app.models import BBox, DocumentResult, Line, PageResult, Word
from app.ocr import consensus
from app.ocr.flags import refine_low_conf_flags
from app.ocr.llm import AiEngine, AiEngineError, get_ai_engine
from app.ocr.tesseract import ocr_tesseract
from app.pdf_input import RenderedPage, render_document
from app.preprocess import preprocess

log = logging.getLogger(__name__)

UI_MAX_SIDE = 2400  # stored page images
AI_MAX_SIDE = 2200  # image sent to AI engines
AI_WORKERS = 4
REGION_MARGIN = 0.01  # normalized margin added around a re-OCR region


def resolve_engine(engine: str, settings: Settings) -> AiEngine | None:
    """The AI engine to use for `engine` ("auto" → settings.default_ai_engine if configured)."""
    if engine == "offline":
        return None
    name = settings.default_ai_engine if engine == "auto" else engine
    return get_ai_engine(name, settings)


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


def _save_jpeg(path: Path, img: np.ndarray, quality: int = 85) -> None:
    path.write_bytes(_jpeg(_resize_max(img, UI_MAX_SIDE), quality))


def _ai_read(
    ai: AiEngine, gray: np.ndarray, tess: list[Line], page: int, mode: str = "page"
) -> tuple[list[Line], list[str], bool]:
    """Run the AI engine and merge with Tesseract. Returns (lines, warnings, ai_used)."""
    try:
        text = ai.transcribe(_jpeg(_resize_max(gray, AI_MAX_SIDE), 90), mode)  # type: ignore[arg-type]
    except AiEngineError as exc:
        return (
            tess,
            [f"خواندن با {ai.name} ناموفق بود: {exc} — نتیجه‌ی Tesseract استفاده شد."],
            False,
        )
    except Exception as exc:  # never fail the whole document because of one AI call
        log.exception("AI engine %s failed", ai.name)
        return tess, [f"خطای غیرمنتظره در {ai.name}: {exc} — نتیجه‌ی Tesseract استفاده شد."], False
    lines, warnings = consensus.merge(text, tess, page)
    return lines, warnings, lines is not tess


def _process_page(
    rp: RenderedPage, kind: str, ai: AiEngine | None, settings: Settings, out_dir: Path
) -> PageResult:
    orig_path = out_dir / f"{kind}-{rp.index}-orig.jpg"
    proc_path = out_dir / f"{kind}-{rp.index}.jpg"
    _save_jpeg(orig_path, rp.image_bgr)

    if rp.text_lines is not None:
        _save_jpeg(proc_path, rp.image_bgr)
        h, w = rp.image_bgr.shape[:2]
        return PageResult(
            index=rp.index,
            width=w,
            height=h,
            source="text_layer",
            engine="text_layer",
            lines=rp.text_lines,
        )

    gray, steps = preprocess(rp.image_bgr, settings.tesseract_cmd, settings.tessdata_dir)
    _save_jpeg(proc_path, gray)
    h, w = gray.shape[:2]
    warnings: list[str] = []
    try:
        tess = ocr_tesseract(gray, rp.index, settings)
    except Exception as exc:
        log.exception("tesseract failed on page %s", rp.index)
        tess = []
        warnings.append(f"Tesseract روی این صفحه خطا داد: {exc}")

    engine_name = "tesseract"
    lines = tess
    if ai is not None:
        lines, ai_warnings, used = _ai_read(ai, gray, tess, rp.index)
        warnings += ai_warnings
        if used:
            engine_name = f"{ai.name}+tesseract"
    return PageResult(
        index=rp.index,
        width=w,
        height=h,
        source="ocr",
        engine=engine_name,
        preprocess=steps,
        lines=lines,
        warnings=warnings,
    )


def process_document(
    pdf_bytes: bytes,
    kind: str,
    filename: str,
    engine: str,
    settings: Settings,
    out_dir: Path,
    on_progress: Callable[[int, int], None] | None = None,
) -> DocumentResult:
    out_dir.mkdir(parents=True, exist_ok=True)
    ai = resolve_engine(engine, settings)
    missing_engine_warning = (
        f"موتور {engine} پیکربندی نشده است؛ فقط Tesseract استفاده شد."
        if ai is None and engine in ("claude", "gemini")
        else None
    )

    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
        total = doc.page_count
    done = 0
    lock = threading.Lock()

    def finished() -> None:
        nonlocal done
        with lock:
            done += 1
            if on_progress:
                on_progress(done, total)

    if on_progress:
        on_progress(0, total)

    def work(rp: RenderedPage) -> PageResult:
        try:
            result = _process_page(rp, kind, ai, settings, out_dir)
            if missing_engine_warning and result.source == "ocr":
                result.warnings.insert(0, missing_engine_warning)
            return result
        finally:
            finished()

    # Rendering is sequential (bounded memory: at most AI_WORKERS pages in flight); OCR and
    # network-bound AI calls run in a small pool. Tesseract itself is CPU-bound, so with no
    # AI engine the pool is small too.
    workers = AI_WORKERS if ai is not None else 2
    results: list[PageResult] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = []
        for rp in render_document(pdf_bytes, settings.render_dpi):
            pending.append(pool.submit(work, rp))
            if len(pending) >= workers * 2:
                results.append(pending.pop(0).result())
        results.extend(f.result() for f in pending)
    results.sort(key=lambda p: p.index)
    doc = DocumentResult(kind=kind, filename=filename, pages=results)  # type: ignore[arg-type]
    refine_low_conf_flags(doc)
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


def reocr_region(
    image_path: Path, bbox: BBox, engine: str, settings: Settings, page: int = 0
) -> list[Line]:
    """Re-read one region of a stored processed page image. `bbox` is normalized on that
    image; returned lines have full-page normalized bboxes."""
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
        return []
    crop_box = (px0 / w, py0 / h, px1 / w, py1 / h)
    # Stored images are downscaled for the UI; give Tesseract enough pixels again.
    if crop.shape[1] < 1600:
        crop = cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)

    tess = ocr_tesseract(crop, page, settings, psm=6)
    ai = resolve_engine(engine, settings)
    if ai is None and engine in ("claude", "gemini"):
        raise AiEngineError(f"موتور {engine} پیکربندی نشده است (کلید API تنظیم نشده).")
    lines = tess
    if ai is not None:
        try:
            text = ai.transcribe(_jpeg(_resize_max(crop, AI_MAX_SIDE), 90), "region")
            lines, _ = consensus.merge(text, tess, page)
        except AiEngineError:
            if engine != "auto":
                raise
    return _map_back(lines, crop_box)
