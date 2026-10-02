"""PDF rendering and text-layer extraction.

`render_document` yields one `RenderedPage` per page: the page rendered to a BGR image and,
when the PDF carries a trustworthy text layer, its words (flat, `text_words`) and the same
words grouped into reading-order lines (`text_lines`). Both are None when the text layer is
missing, garbled, visually reversed beyond repair, or belongs to an image-only scan (the
weak invisible OCR layer CamScanner / iOS add) — the caller then OCRs the image.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterator
from dataclasses import dataclass

import cv2
import numpy as np
import pymupdf

from app.models import Line, Word

# A page whose text layer has fewer characters than this is OCR'd instead.
MIN_TEXT_CHARS = 20
# A single image covering this share of the page means "scanned page".
FULL_PAGE_IMAGE_RATIO = 0.8

_ARABIC_RE = re.compile("[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]")
_LATIN_RE = re.compile(r"[A-Za-z]")

# PDFs store the *mirrored* glyph for brackets inside RTL runs, so "۱)" extracts as "۱(".
_MIRROR = str.maketrans("()[]{}<>«»", ")(][}{><»«")

_COMMON_WORDS = {"از", "به", "در", "که", "این", "را", "با", "است", "و", "یا", "بر", "تا"}
_REVERSED_COMMON = {w[::-1] for w in _COMMON_WORDS if len(w) > 1}


@dataclass
class RenderedPage:
    """One rendered PDF page.

    `text_words` is the flat list of words of `text_lines` (reading order); both are None
    when the text layer is not usable and the page must be OCR'd. BBoxes are normalized to
    the page (and therefore to `image_bgr`).
    """

    index: int
    image_bgr: np.ndarray
    text_words: list[Word] | None = None
    text_lines: list[Line] | None = None
    # Why the text layer was rejected (for logs/warnings); None when used or absent.
    text_layer_note: str | None = None


# --------------------------------------------------------------------------- quality checks


def is_garbage(text: str) -> bool:
    """True when the text looks like broken font encoding rather than real text: private-use
    glyphs, replacement chars, control chars, or Latin-1 mojibake of Persian (e.g. "ÇáÚ")."""
    chars = [c for c in text if not c.isspace()]
    if not chars:
        return True
    bad = 0
    mojibake = 0
    for c in chars:
        cp = ord(c)
        if 0xE000 <= cp <= 0xF8FF or cp == 0xFFFD or unicodedata.category(c) in ("Cc", "Cs", "Co"):
            bad += 1
        elif 0x00C0 <= cp <= 0x024F or 0x0080 <= cp <= 0x00BF:
            mojibake += 1
    n = len(chars)
    arabic = sum(1 for c in chars if _ARABIC_RE.match(c))
    if bad / n > 0.05:
        return True
    # Accented Latin dominating with (almost) no Arabic script = custom-encoded Persian font.
    return mojibake / n > 0.3 and arabic / n < 0.2


def is_reversed_persian(words: list[str]) -> bool:
    """True when Persian words appear with their characters in visual (reversed) order."""
    fwd = sum(1 for w in words if w in _COMMON_WORDS)
    rev = sum(1 for w in words if w in _REVERSED_COMMON)
    return rev >= 3 and rev > 2 * fwd


def fix_reversed(word: str) -> str:
    """Reverse the characters of a word that contains Arabic script (digits/Latin kept)."""
    return word[::-1] if _ARABIC_RE.search(word) else word


def _clean(text: str) -> str:
    # NFKC folds Arabic presentation forms (U+FB50–U+FEFF) to the base letters.
    text = unicodedata.normalize("NFKC", text)
    return text.replace("\u200f", "").replace("\u200e", "").strip()


# ----------------------------------------------------------------------------- extraction


@dataclass
class _RawWord:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float


def _chars_to_word(chars: list[dict], rot: pymupdf.Matrix) -> _RawWord:
    r = pymupdf.Rect()
    for c in chars:
        r |= pymupdf.Rect(c["bbox"]) * rot
    return _RawWord("".join(c["c"] for c in chars), r.x0, r.y0, r.x1, r.y1)


def _raw_words(page: pymupdf.Page) -> tuple[list[list[_RawWord]], int]:
    """Words per PDF text line (in displayed-page coordinates), built from characters split
    on whitespace so that glyph runs broken at non-joining letters are kept together.
    Also returns the number of characters on lines that are not horizontal as displayed."""
    out: list[list[_RawWord]] = []
    raw = page.get_text("rawdict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE)
    rot = page.rotation_matrix
    off_axis = 0
    for block in raw["blocks"]:
        for line in block.get("lines", []):
            dx, dy = line["dir"]
            shown = pymupdf.Point(dx, dy) * pymupdf.Matrix(rot.a, rot.b, rot.c, rot.d, 0, 0)
            if abs(shown.x) < 0.95:
                off_axis += sum(len(sp["chars"]) for sp in line["spans"])
                continue
            words: list[_RawWord] = []
            for span in line["spans"]:
                cur: list[dict] = []
                for ch in span["chars"]:
                    if ch["c"].isspace():
                        if cur:
                            words.append(_chars_to_word(cur, rot))
                        cur = []
                    else:
                        cur.append(ch)
                if cur:  # adjacent fragments of one word are re-joined in _order_line
                    words.append(_chars_to_word(cur, rot))
            if words:
                out.append(words)
    return out, off_axis


def _group_lines(pdf_lines: list[list[_RawWord]]) -> list[list[_RawWord]]:
    """Merge PDF lines that share a vertical band (bidi runs on the same visual line)."""
    items = sorted(pdf_lines, key=lambda ws: min(w.y0 for w in ws))
    bands: list[tuple[float, float, list[_RawWord]]] = []
    for ws in items:
        y0 = min(w.y0 for w in ws)
        y1 = max(w.y1 for w in ws)
        for i, (by0, by1, bws) in enumerate(bands):
            overlap = min(y1, by1) - max(y0, by0)
            if overlap > 0.5 * min(y1 - y0, by1 - by0):
                bands[i] = (min(by0, y0), max(by1, y1), bws + ws)
                break
        else:
            bands.append((y0, y1, list(ws)))
    return [b[2] for b in sorted(bands, key=lambda b: b[0])]


def _order_line(words: list[_RawWord]) -> list[_RawWord]:
    """Visual → reading order. RTL lines run right-to-left; touching fragments are joined."""
    rtl = any(_ARABIC_RE.search(w.text) for w in words)
    words = sorted(words, key=lambda w: -w.x1 if rtl else w.x0)
    merged: list[_RawWord] = []
    for w in words:
        if merged:
            p = merged[-1]
            h = max(p.y1 - p.y0, w.y1 - w.y0, 1e-6)
            gap = (p.x0 - w.x1) if rtl else (w.x0 - p.x1)
            if gap < 0.08 * h:
                merged[-1] = _RawWord(
                    p.text + w.text,
                    min(p.x0, w.x0),
                    min(p.y0, w.y0),
                    max(p.x1, w.x1),
                    max(p.y1, w.y1),
                )
                continue
        merged.append(w)
    if rtl:
        # Embedded LTR runs (Latin words) keep their own left-to-right order.
        out: list[_RawWord] = []
        run: list[_RawWord] = []
        for w in merged:
            if _LATIN_RE.search(w.text) and not _ARABIC_RE.search(w.text):
                run.append(w)
            else:
                out.extend(reversed(run))
                run = []
                out.append(w)
        out.extend(reversed(run))
        merged = [
            w
            if _LATIN_RE.search(w.text)
            else _RawWord(w.text.translate(_MIRROR), w.x0, w.y0, w.x1, w.y1)
            for w in out
        ]
    return merged


def _has_full_page_image(page: pymupdf.Page) -> bool:
    area = abs(page.rect)
    if area <= 0:
        return False
    for info in page.get_image_info():
        if abs(pymupdf.Rect(info["bbox"]) & page.rect) >= FULL_PAGE_IMAGE_RATIO * area:
            return True
    return False


def extract_text_lines(page: pymupdf.Page, index: int) -> tuple[list[Line] | None, str | None]:
    """Text-layer lines in reading order, or (None, reason) when the layer is not usable."""
    pdf_lines, off_axis = _raw_words(page)
    all_text = " ".join(w.text for ws in pdf_lines for w in ws)
    n_chars = sum(1 for c in all_text if not c.isspace())
    if off_axis > n_chars:
        return None, "rotated_text"  # sideways text: OCR fixes the orientation
    if n_chars < MIN_TEXT_CHARS:
        return None, "no_text" if n_chars == 0 else "too_little_text"
    if _has_full_page_image(page):
        return None, "scanned_image"
    if is_garbage(all_text):
        return None, "garbage"

    cleaned = [[_RawWord(_clean(w.text), w.x0, w.y0, w.x1, w.y1) for w in ws] for ws in pdf_lines]
    reversed_ = is_reversed_persian([w.text for ws in cleaned for w in ws])

    pw, ph = page.rect.width, page.rect.height
    lines: list[Line] = []
    for band in _group_lines(cleaned):
        ws = [w for w in band if w.text]
        if reversed_:
            ws = [_RawWord(fix_reversed(w.text), w.x0, w.y0, w.x1, w.y1) for w in ws]
        words = [
            Word(
                text=w.text,
                bbox=(
                    _clip(w.x0 / pw),
                    _clip(w.y0 / ph),
                    _clip(w.x1 / pw),
                    _clip(w.y1 / ph),
                ),
            )
            for w in _order_line(ws)
        ]
        if words:
            lines.append(Line(page=index, words=words, bbox=union_bbox(w.bbox for w in words)))
    return lines, None


def _clip(v: float) -> float:
    return min(1.0, max(0.0, v))


def union_bbox(boxes) -> tuple[float, float, float, float] | None:
    bs = [b for b in boxes if b is not None]
    if not bs:
        return None
    return (
        min(b[0] for b in bs),
        min(b[1] for b in bs),
        max(b[2] for b in bs),
        max(b[3] for b in bs),
    )


# Hard cap on rendered pixels: a full A4 page at 300 dpi is ~8.7 MP.
MAX_RENDER_PIXELS = 12_000_000


def effective_dpi(page: pymupdf.Page, dpi: int) -> float:
    """Never render above the resolution of the scan embedded in the page.

    Phone scanners (iOS, CamScanner) often write the page size in pixels-as-points
    (e.g. 1893 x 2824 pt for a 1892 x 2822 px photo); rendering that at 300 dpi
    makes a ~90 MP upsampled image that only slows OCR down.
    """
    rect = page.rect
    if rect.width <= 0 or rect.height <= 0:
        return dpi
    target = float(dpi)
    images = page.get_image_info()
    if images:
        biggest = max(images, key=lambda i: i["width"] * i["height"])
        x0, y0, x1, y1 = biggest["bbox"]
        if (x1 - x0) * (y1 - y0) >= 0.5 * rect.width * rect.height and x1 > x0:
            native = biggest["width"] / ((x1 - x0) / 72)
            target = min(target, max(native, 72.0))
    cap = (MAX_RENDER_PIXELS / (rect.width * rect.height)) ** 0.5 * 72
    return max(36.0, min(target, cap))


def render_page(page: pymupdf.Page, dpi: int) -> np.ndarray:
    zoom = effective_dpi(page, dpi) / 72
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False, colorspace=pymupdf.csRGB)
    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
    return cv2.cvtColor(img, cv2.COLOR_RGB2BGR)


def render_document(pdf_bytes: bytes, dpi: int) -> Iterator[RenderedPage]:
    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
        for i, page in enumerate(doc):
            try:
                lines, note = extract_text_lines(page, i)
            except Exception as exc:  # noqa: BLE001 — malformed content: just OCR the page
                lines, note = None, f"error: {exc}"
            yield RenderedPage(
                index=i,
                image_bgr=render_page(page, dpi),
                text_words=[w for ln in lines for w in ln.words] if lines is not None else None,
                text_lines=lines,
                text_layer_note=note,
            )
