"""Offline OCR quality score of a page (0..1) — decides whether the AI is needed at all.

Signals (computed on the page's words after document-level flag refinement):

* flagged share   — words flagged as probably wrong (`Word.flag`).      weight 0.30
* lexicon share   — Persian words found in the lexicon (fa words, legal
                    terms, admin-learned words); digits/markers count.   weight 0.35
* confidence      — mean Tesseract confidence.                         weight 0.20
* garbage share   — malformed tokens, Latin junk, 1-char fragments.    weight 0.15

The weighted sum is multiplied by a coverage factor: a page with plenty of ink but very
little recognized text (wrong orientation, heavy blur, segmentation failure) scores low.
A page with (almost) no ink is blank: nothing for the AI to read, score 1.

Calibrated on the synthetic fixtures (tests/fixtures_gen.py, tessdata_best + fas):
clean scan ≈ 0.95, phone scans ≈ 0.9, unreadable/blurred page < 0.4.
"""

from __future__ import annotations

import re

import cv2
import numpy as np

from app.models import PageResult, Word
from app.ocr.flags import is_malformed, known_words, learned_words, word_key

W_FLAG, W_LEX, W_CONF, W_GARBAGE = 0.30, 0.35, 0.20, 0.15

BLANK_INK = 0.002  # share of dark pixels below which a page counts as blank
# Recognized characters expected per unit of ink share (measured ≈ 25k on booklet pages:
# ~1000 chars at ~4% ink). Coverage below a quarter of that is suspicious.
CHARS_PER_INK = 25_000.0

_PERSIAN_RE = re.compile("[؀-ۿ]")
_LATIN_RE = re.compile("[A-Za-z]")
_NUMERIC_RE = re.compile(r"^[(\[]?[0-9۰-۹٠-٩]+[)\].\-/:]*$")
_MARKER_RE = re.compile(r"^\(?(?:[0-9۰-۹]{1,3}|الف|ب|ج|د)[)\-.]$")


def _clamp(v: float) -> float:
    return max(0.0, min(1.0, v))


def _is_known(w: Word, lexicon: frozenset[str]) -> bool | None:
    """True/False for lexicon-checkable words, None for neutral tokens (punctuation)."""
    text = w.text.strip()
    if _NUMERIC_RE.match(text) or _MARKER_RE.match(text):
        return True
    key = word_key(text)
    if not key or not _PERSIAN_RE.search(key):
        return None if not _LATIN_RE.search(text) else False
    return key in lexicon


def _is_garbage(w: Word) -> bool:
    text = w.text.strip()
    if is_malformed(text):
        return True
    key = word_key(text)
    if _LATIN_RE.search(text) and _PERSIAN_RE.search(text):
        return True
    # Lone letters other than و (and) / option letters are typical segmentation debris.
    return (
        len(key) == 1 and key.isalpha() and _PERSIAN_RE.match(key) is not None and key not in "وبجد"
    )


def page_quality(page: PageResult, ink_ratio: float | None = None) -> float:
    """Quality 0..1 of `page`'s offline reading. `ink_ratio` (share of dark pixels in the
    processed image) enables the blank-page and coverage checks."""
    words = [w for ln in page.lines for w in ln.words if w.text.strip()]
    if ink_ratio is not None and ink_ratio < BLANK_INK:
        return 1.0
    if not words:
        return 0.0
    n = len(words)
    lexicon = known_words() | learned_words()

    flagged = sum(1 for w in words if w.flag is not None) / n
    known = [k for k in (_is_known(w, lexicon) for w in words) if k is not None]
    lex = sum(known) / len(known) if known else 0.0
    confs = [w.conf for w in words if w.conf is not None]
    conf = sum(confs) / len(confs) if confs else 85.0
    garbage = sum(1 for w in words if _is_garbage(w)) / n

    score = (
        W_FLAG * _clamp(1 - flagged / 0.30)
        + W_LEX * _clamp((lex - 0.30) / 0.55)
        + W_CONF * _clamp((conf - 40) / 50)
        + W_GARBAGE * _clamp(1 - garbage / 0.25)
    )
    if ink_ratio is not None:
        chars = sum(len(w.text) for w in words)
        expected = ink_ratio * CHARS_PER_INK
        score *= _clamp(chars / (0.25 * expected)) if expected > 0 else 1.0
    return round(_clamp(score), 3)


def ink_ratio(gray: np.ndarray) -> float:
    """Share of dark (ink) pixels of a gray page image (downscaled for speed)."""
    h, w = gray.shape[:2]
    s = 800 / max(h, w)
    small = cv2.resize(gray, (max(1, int(w * s)), max(1, int(h * s)))) if s < 1 else gray
    mask = cv2.adaptiveThreshold(
        small, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 15
    )
    return float((mask > 0).mean())
