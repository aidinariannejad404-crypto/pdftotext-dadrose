"""Document-level refinement of Tesseract "low_conf" flags.

Tesseract's per-word confidence alone flags far too many correct Persian words
(e.g. «کدام» at 55), which buries the real errors. Two extra signals:

* lexicon — a known Persian word (Tesseract's own `fas` word list, extracted
  from tessdata_best, Apache-2.0, plus `data/legal_terms.txt`) or a word read
  elsewhere in the same document with high confidence is trusted even when
  this occurrence scored lower;
* shape — malformed tokens (digits glued to letters, punctuation inside a
  word, stray diacritics, Arabic ي/ك, Latin mixed into Persian) are suspicious
  even at medium confidence.
"""

from __future__ import annotations

import re
import unicodedata
from functools import lru_cache
from pathlib import Path

from app.models import DocumentResult, Word

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

ALWAYS_BELOW = 20.0  # flag regardless of the lexicon
CHECK_BELOW = 60.0  # flag unless the lexicon vouches for the word
SHAPE_BELOW = 88.0  # malformed words are flagged up to this confidence
TRUSTED_CONF = 80.0

_EDGE_PUNCT = "«»()[]{}\"'.,،;؛:!?؟-–—ـ*•"
_PERSIAN = r"؀-ۿ‌"
_MALFORMED = [
    re.compile(rf"[{_PERSIAN}][0-9۰-۹٠-٩]|[0-9۰-۹٠-٩][{_PERSIAN}]"),  # letter+digit glued
    re.compile(rf"[{_PERSIAN}][.:،,؛;][{_PERSIAN}]"),  # punctuation inside a word
    re.compile(r"[ً-ِْ]"),  # diacritics (rare in modern print, common OCR noise)
    re.compile(r"[يكة]"),  # Arabic letters a Persian print would not use
    re.compile(rf"[A-Za-z][{_PERSIAN}]|[{_PERSIAN}][A-Za-z]"),  # Latin glued to Persian
    re.compile(r"(.)\1\1"),  # tripled character
]
_OPTION_MARKER = re.compile(r"^\(?(?:[0-9۰-۹]{1,3}|الف|ب|ج|د)[\)\-.]$")


def _key(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).strip(_EDGE_PUNCT)
    return text.replace("ي", "ی").replace("ك", "ک").replace("‌", "")


@lru_cache(maxsize=1)
def known_words() -> frozenset[str]:
    words: set[str] = set()
    for name in ("fa_words.txt", "legal_terms.txt"):
        path = DATA_DIR / name
        if path.is_file():
            for line in path.read_text("utf-8").splitlines():
                if line and not line.startswith("#"):
                    words.add(_key(line))
    return frozenset(words)


def is_malformed(text: str) -> bool:
    core = text.strip(_EDGE_PUNCT)
    if not core or _OPTION_MARKER.match(text.strip()):
        return False
    return any(p.search(core) for p in _MALFORMED)


def refine_low_conf_flags(doc: DocumentResult) -> int:
    """Recompute `low_conf` flags in place. Returns the number of flagged words."""
    words: list[Word] = [w for p in doc.pages for line in p.lines for w in line.words]
    trusted = set(known_words()) | {
        _key(w.text)
        for w in words
        if w.conf is not None and w.conf >= TRUSTED_CONF and not is_malformed(w.text)
    }
    flagged = 0
    for word in words:
        if word.flag == "disagree" or word.conf is None:
            flagged += word.flag is not None
            continue
        key = _key(word.text)
        marker = bool(_OPTION_MARKER.match(word.text.strip()))
        suspicious = (
            bool(key)
            and not (marker and word.conf >= ALWAYS_BELOW)
            and (
                word.conf < ALWAYS_BELOW
                or (word.conf < CHECK_BELOW and key not in trusted)
                or (word.conf < SHAPE_BELOW and is_malformed(word.text))
            )
        )
        word.flag = "low_conf" if suspicious else None
        flagged += suspicious
    return flagged
