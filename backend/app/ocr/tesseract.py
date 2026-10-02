"""Offline OCR with Tesseract (always runs: it supplies word boxes and confidences)."""

from __future__ import annotations

import os
import re
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
import pytesseract

from app.config import Settings
from app.models import Line, Word

# Pages are OCR'd in parallel threads; Tesseract's own OpenMP threads then fight over the
# cores and a 6 s page can take minutes. One OpenMP thread per process is far faster.
os.environ.setdefault("OMP_THREAD_LIMIT", "1")

LOW_CONF = 60.0
_ARABIC_RE = re.compile("[\u0600-\u06ff]")
WATERMARK_RE = re.compile(
    r"cam\s*scanner|scanned\s+(with|by|using)|اسکن\s*شده\s*(با|توسط)|adobe\s*scan|"
    r"genius\s*scan|tiny\s*scanner|clear\s*scan|microsoft\s*lens|office\s*lens|"
    r"کم\s*اسکنر",
    re.IGNORECASE,
)


def tessdata_flag(tessdata_dir: str) -> str:
    """`--tessdata-dir` option, or "" when the directory is passed via TESSDATA_PREFIX.

    On Windows pytesseract splits the config non-POSIX style, so a quoted path
    (``C:\\Program Files\\...``) reaches Tesseract with the quotes still on;
    the environment variable avoids quoting entirely.
    """
    if not tessdata_dir:
        return ""
    if sys.platform == "win32":
        os.environ["TESSDATA_PREFIX"] = tessdata_dir
        return ""
    return f' --tessdata-dir "{tessdata_dir}"'


def tesseract_config(settings: Settings, psm: int) -> str:
    return f"--oem 1 --psm {psm} -c preserve_interword_spaces=1" + tessdata_flag(
        settings.tessdata_dir
    )


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
    except Exception:  # noqa: BLE001 — any failure means "not available"
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
        # Tesseract's LSTM emits words in logical reading order (right-to-left for Persian);
        # its RTL word boxes are often bloated and overlap, so geometry is a worse guide.
        words = [w for _, w in groups[key]]
        if any(_ARABIC_RE.search(w.text) for w in words):
            _tighten_rtl_boxes(words)
        text = " ".join(w.text for w in words)
        if WATERMARK_RE.search(text):
            continue
        lines.append(Line(page=page, words=words, bbox=_union(w.bbox for w in words)))
    return lines


def _tighten_rtl_boxes(words: list[Word]) -> None:
    """Clip each word box so it doesn't extend over its RTL neighbours (in reading order the
    previous word lies to the right, the next to the left)."""
    for i, w in enumerate(words):
        if w.bbox is None:
            continue
        x0, y0, x1, y1 = w.bbox
        prev = words[i - 1].bbox if i > 0 else None
        nxt = words[i + 1].bbox if i + 1 < len(words) else None
        if prev is not None and prev[0] < x1 and prev[0] > x0:
            x1 = prev[0]
        if nxt is not None and nxt[2] > x0 and nxt[2] < x1:
            x0 = nxt[2]
        if x1 > x0:
            w.bbox = (x0, y0, x1, y1)


def _union(boxes) -> tuple[float, float, float, float] | None:
    bs = [b for b in boxes if b is not None]
    if not bs:
        return None
    return (
        min(b[0] for b in bs),
        min(b[1] for b in bs),
        max(b[2] for b in bs),
        max(b[3] for b in bs),
    )


def is_multicolumn(gray: np.ndarray) -> bool:
    """True when the page has a vertical gutter (empty band) near the middle that runs
    through most of the text — i.e. a two-column layout."""
    h, w = gray.shape[:2]
    s = 800 / max(h, w)
    small = (
        cv2.resize(gray, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA) if s < 1 else gray
    )
    mask = cv2.adaptiveThreshold(
        small, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 15
    )
    sw = mask.shape[1]
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


def ocr_tesseract(
    gray: np.ndarray, page: int, settings: Settings, psm: int | None = None
) -> list[Line]:
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
