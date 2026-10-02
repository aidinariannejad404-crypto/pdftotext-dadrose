"""Merge an AI transcription (primary reading) with Tesseract (geometry + second opinion).

The AI text decides *what* the words are and how lines are structured; Tesseract decides
*where* they are. Tokens both engines agree on are trusted; AI tokens Tesseract read
differently are flagged "disagree" with Tesseract's reading in `alt`.
"""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

from app.models import BBox, Line, Word

LOW_AGREEMENT = 0.40

_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")
_CHARS = str.maketrans({"ي": "ی", "ى": "ی", "ئ": "ی", "ك": "ک", "ة": "ه", "ۀ": "ه", "أ": "ا", "إ": "ا", "آ": "ا"})
# ZWNJ, ZWJ, tatweel, bidi marks, harakat (tashkil).
_STRIP_RE = re.compile(r"[‌‍‎‏ـً-ٰٟ]")
_PUNCT_RE = re.compile(r"[^\w]", re.UNICODE)


def comparable(s: str) -> str:
    """Aggressively normalized form used only for comparing readings."""
    s = unicodedata.normalize("NFKC", s)
    s = _STRIP_RE.sub("", s)
    s = s.translate(_CHARS).translate(_DIGITS)
    return _PUNCT_RE.sub("", s).lower()


def _tokens_equal(a: str, b: str) -> bool:
    ca, cb = comparable(a), comparable(b)
    if ca == cb:
        return True
    # Punctuation-only tokens (e.g. "-" vs "–") count as equal.
    return not ca and not cb


def _union(boxes) -> BBox | None:
    bs = [b for b in boxes if b is not None]
    if not bs:
        return None
    return (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))


def _split_box(box: BBox | None, n: int, rtl: bool = True) -> list[BBox | None]:
    """Split a box horizontally into n equal parts in reading order."""
    if box is None or n <= 0:
        return [None] * n
    x0, y0, x1, y1 = box
    step = (x1 - x0) / n
    parts = [(x0 + i * step, y0, x0 + (i + 1) * step, y1) for i in range(n)]
    return parts[::-1] if rtl else parts


def _tokenize_ai(ai_text: str) -> list[list[str]]:
    text = ai_text.replace("\r\n", "\n").replace("\r", "\n")
    lines = []
    for raw in text.split("\n"):
        # Table rows "a | b | c" keep the separators as tokens for the parser.
        toks = raw.split()
        if toks:
            lines.append(toks)
    return lines


def _merge_near_identical(
    ai: list[str], tess: list[str]
) -> bool:
    """AI span equals Tesseract span once spaces are removed (ZWNJ vs space splits)."""
    return comparable("".join(ai)) == comparable("".join(tess)) and bool(comparable("".join(ai)))


def merge(ai_text: str, tess_lines: list[Line], page: int) -> tuple[list[Line], list[str]]:
    warnings: list[str] = []
    ai_lines = _tokenize_ai(ai_text)
    tess_words: list[Word] = [w for ln in tess_lines for w in ln.words]
    tess_line_of: list[int] = [i for i, ln in enumerate(tess_lines) for _ in ln.words]

    if not ai_lines:
        if tess_words:
            warnings.append("موتور هوش مصنوعی متنی برنگرداند؛ نتیجه‌ی Tesseract استفاده شد.")
        return tess_lines, warnings
    if not tess_words:
        lines = [
            Line(page=page, words=[Word(text=t) for t in toks], bbox=None) for toks in ai_lines
        ]
        return lines, warnings

    ai_flat: list[str] = [t for toks in ai_lines for t in toks]
    ai_line_of: list[int] = [i for i, toks in enumerate(ai_lines) for _ in toks]
    a_keys = [comparable(t) or t for t in ai_flat]
    t_keys = [comparable(w.text) or w.text for w in tess_words]

    out_words: list[Word | None] = [None] * len(ai_flat)
    matched_tess = [False] * len(tess_words)
    agreed = 0

    sm = SequenceMatcher(None, a_keys, t_keys, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                tw = tess_words[j1 + k]
                out_words[i1 + k] = Word(text=ai_flat[i1 + k], bbox=tw.bbox, conf=tw.conf)
                matched_tess[j1 + k] = True
            agreed += i2 - i1
        elif tag == "replace":
            ai_span, tess_span = ai_flat[i1:i2], tess_words[j1:j2]
            for j in range(j1, j2):
                matched_tess[j] = True
            box = _union(w.bbox for w in tess_span)
            conf = min((w.conf for w in tess_span if w.conf is not None), default=None)
            if (i2 - i1) == (j2 - j1):
                # One-to-one: pair tokens positionally; equal-ish ones are agreements.
                for k in range(i2 - i1):
                    tw = tess_span[k]
                    if _tokens_equal(ai_span[k], tw.text):
                        out_words[i1 + k] = Word(text=ai_span[k], bbox=tw.bbox, conf=tw.conf)
                        agreed += 1
                    else:
                        out_words[i1 + k] = Word(
                            text=ai_span[k], bbox=tw.bbox, conf=tw.conf, flag="disagree", alt=tw.text
                        )
                continue
            same = _merge_near_identical(ai_span, [w.text for w in tess_span])
            alt = " ".join(w.text for w in tess_span)
            for k, b in enumerate(_split_box(box, i2 - i1)):
                if same:
                    out_words[i1 + k] = Word(text=ai_span[k], bbox=b, conf=conf)
                else:
                    out_words[i1 + k] = Word(
                        text=ai_span[k], bbox=b, conf=conf, flag="disagree", alt=alt
                    )
            if same:
                agreed += i2 - i1
        elif tag == "insert":  # AI tokens with no Tesseract counterpart
            for k in range(i1, i2):
                out_words[k] = Word(text=ai_flat[k], flag="disagree", alt="")
        # "delete": Tesseract-only tokens; handled by the omitted-line check below.

    # Assemble lines following the AI structure; estimate missing boxes from neighbours.
    result: list[Line] = []
    pos = 0
    for li, toks in enumerate(ai_lines):
        words = [w for w in out_words[pos : pos + len(toks)] if w is not None]
        pos += len(toks)
        _estimate_missing_boxes(words)
        result.append(Line(page=page, words=words, bbox=_union(w.bbox for w in words)))
    del ai_line_of

    # Tesseract lines with several confident words and no match at all → AI may have
    # skipped them.
    for li, ln in enumerate(tess_lines):
        idx = [k for k, x in enumerate(tess_line_of) if x == li]
        confident = [k for k in idx if (tess_words[k].conf or 0) >= 70]
        if len(confident) >= 3 and not any(matched_tess[k] for k in idx):
            warnings.append(
                f"احتمال جاافتادن یک سطر در متن هوش مصنوعی: «{ln.text[:60]}»"
            )

    agreement = agreed / max(len(ai_flat), len(tess_words))
    if agreement < LOW_AGREEMENT:
        warnings.append(
            f"توافق متن هوش مصنوعی با Tesseract بسیار کم است ({agreement:.0%})؛ "
            "احتمالاً پاسخ هوش مصنوعی نادرست است. نتیجه‌ی Tesseract استفاده شد."
        )
        return tess_lines, warnings
    return result, warnings


def _estimate_missing_boxes(words: list[Word]) -> None:
    """Give box-less (inserted) words a thin box next to their nearest boxed neighbour on
    the same line (RTL: the following word sits to the left)."""
    for i, w in enumerate(words):
        if w.bbox is not None:
            continue
        prev = next((words[j].bbox for j in range(i - 1, -1, -1) if words[j].bbox), None)
        nxt = next((words[j].bbox for j in range(i + 1, len(words)) if words[j].bbox), None)
        if prev and nxt and prev[0] > nxt[2]:
            w.bbox = (nxt[2], min(prev[1], nxt[1]), prev[0], max(prev[3], nxt[3]))
        elif prev:
            width = min(prev[2] - prev[0], 0.05)
            w.bbox = (max(0.0, prev[0] - width), prev[1], prev[0], prev[3])
        elif nxt:
            width = min(nxt[2] - nxt[0], 0.05)
            w.bbox = (nxt[2], nxt[1], min(1.0, nxt[2] + width), nxt[3])
