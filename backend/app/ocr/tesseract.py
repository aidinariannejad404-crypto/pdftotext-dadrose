"""Offline OCR with Tesseract (always runs: it supplies word boxes and confidences)."""

from __future__ import annotations

import re
import shutil
from pathlib import Path

import cv2
import numpy as np
import pytesseract

from app.config import Settings
from app.models import Line, Word

LOW_CONF = 60.0
_ARABIC_RE = re.compile(r"[؀-ۿ]")
_LATIN_RE = re.compile(r"[A-Za-z]")
WATERMARK_RE = re.compile(
    r"cam\s*scanner|scanned\s+(with|by|using)|اسکن\s*شده\s*(با|توسط)|adobe\s*scan|"
    r"genius\s*scan|tiny\s*scanner|clear\s*scan|microsoft\s*lens|office\s*lens|"
    r"کم\s*اسکنر",
    re.IGNORECASE,
)


def tesseract_config(settings: Settings, psm: int) -> str:
    cfg = f"--oem 1 --psm {psm} -c preserve_interword_spaces=1"
    if settings.tessdata_dir:
        cfg += f' --tessdata-dir "{settings.tessdata_dir}"'
    return cfg


def _configure(settings: Settings) -> None:
    if settings.tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = settings.tesseract_cmd


def tesseract_available(settings: Settings, lang: str = "fas") -> bool:
    """True when the tesseract binary and the given traineddata are present."""
    if not shutil.which(settings.tesseract_cmd or "tesseract"):
        return False
    if settings.tessdata_dir:
        return (Path(settings.tessdata_dir) / f"{lang}.traineddata").is_file()
    try:
        _configure(settings)
        return lang in pytesseract.get_languages(config="")
    except Exception:
        return False


def _run(gray: np.ndarray, settings: Settings, psm: int) -> dict[str, list]:
    return pytesseract.image_to_data(
        gray,
        lang=settings.tesseract_lang,
        config=tesseract_config(settings, psm),
        output_type=pytesseract.Output.DICT,
    )


def _to_lines(data: dict[str, list], width: int, height: int, page: int) -> list[Line]:
    groups: dict[tuple[int, int, int], list[tuple[int, Word]]] = {}
    order: list[tuple[int, int, int]] = []
    for i, raw in enumerate(data["text"]):
        text = (raw or "").replace("\u200e", "").replace("\u200f", "").strip()
        if not text:
            continue
        conf = float(data["conf"][i])
        if conf < 0:
            continue
        x, y, w, h = data["left"][i], data["top"][i], data["width"][i], data["height"][i]
        word = Word(
            text=text,
            bbox=(x / width, y / height, (x + w) / width, (y + h) / height),
            conf=round(conf, 1),
            flag="low_conf" if conf < LOW_CONF else None,
        )
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append((x, word))

    lines: list[Line] = []
    for key in order:
        items = groups[key]
        rtl = any(_ARABIC_RE.search(w.text) for _, w in items)
        # Persian lines read right-to-left; Tesseract's own word order is not reliable for
        # mixed runs, so sort by geometry.
        items.sort(key=lambda t: -(t[1].bbox[2]) if rtl else t[1].bbox[0])
        words = [w for _, w in items]
        if rtl:
            words = _restore_ltr_runs(words)
        text = " ".join(w.text for w in words)
        if WATERMARK_RE.search(text):
            continue
        lines.append(Line(page=page, words=words, bbox=_union(w.bbox for w in words)))
    return lines


def _restore_ltr_runs(words: list[Word]) -> list[Word]:
    out: list[Word] = []
    run: list[Word] = []
    for w in words:
        if _LATIN_RE.search(w.text) and not _ARABIC_RE.search(w.text):
            run.append(w)
        else:
            out.extend(reversed(run))
            run = []
            out.append(w)
    out.extend(reversed(run))
    return out


def _union(boxes) -> tuple[float, float, float, float] | None:
    bs = [b for b in boxes if b is not None]
    if not bs:
        return None
    return (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))


def is_multicolumn(gray: np.ndarray) -> bool:
    """True when the page has a vertical gutter (empty band) near the middle that runs
    through most of the text — i.e. a two-column layout."""
    h, w = gray.shape[:2]
    s = 800 / max(h, w)
    small = cv2.resize(gray, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA) if s < 1 else gray
    mask = cv2.adaptiveThreshold(
        small, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 15
    )
    sh, sw = mask.shape
    rows = mask.sum(1) > 0.01 * 255 * sw
    if rows.sum() < 10:
        return False
    ys = np.flatnonzero(rows)
    body = mask[ys[0] : ys[-1] + 1, int(0.05 * sw) : int(0.95 * sw)]
    cols = body.mean(0) / 255.0
    cols = np.convolve(cols, np.ones(5) / 5, mode="same")
    bw = body.shape[1]
    mid = cols[int(0.3 * bw) : int(0.7 * bw)]
    peak = np.percentile(cols, 90)
    if peak <= 0:
        return False
    empty = mid < 0.03 * peak
    # Longest run of empty columns in the middle band.
    best = run = 0
    for e in empty:
        run = run + 1 if e else 0
        best = max(best, run)
    return best >= 0.015 * bw


def ocr_tesseract(gray: np.ndarray, page: int, settings: Settings, psm: int | None = None) -> list[Line]:
    """OCR a (preprocessed) gray page.

    psm: None = automatic — psm 4 (single column, variable sizes: most robust on booklets and
    key tables) unless a two-column layout is detected (psm 3, full segmentation). Falls back
    to psm 6 when the result has very little text."""
    _configure(settings)
    h, w = gray.shape[:2]
    if psm is None:
        psm = 3 if is_multicolumn(gray) else 4
    lines = _to_lines(_run(gray, settings, psm), w, h, page)
    n_chars = sum(len(ln.text) for ln in lines)
    if psm != 6 and n_chars < 40:
        alt = _to_lines(_run(gray, settings, 6), w, h, page)
        if sum(len(ln.text) for ln in alt) > 2 * max(n_chars, 1):
            return alt
    return lines
