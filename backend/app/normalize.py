"""Persian text normalization for OCR output (text layer, Tesseract or AI transcription)."""

from __future__ import annotations

import re
import unicodedata

ZWNJ = "‌"

_PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹"
_ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩"
_ASCII_DIGITS = "0123456789"

_LETTER_MAP = str.maketrans(
    {"ي": "ی", "ى": "ی", "ك": "ک", **dict(zip(_ARABIC_DIGITS, _PERSIAN_DIGITS, strict=True))}
)
_TO_ASCII = str.maketrans(dict(zip(_PERSIAN_DIGITS + _ARABIC_DIGITS, _ASCII_DIGITS * 2, strict=True)))
_TO_PERSIAN = str.maketrans(
    dict(zip(_ASCII_DIGITS + _ARABIC_DIGITS, _PERSIAN_DIGITS * 2, strict=True))
)

_AR_LETTER = "ء-غف-يٱ-ۓۺ-ۿ"
_TATWEEL = re.compile(rf"(?<=[{_AR_LETTER}])ـ+(?=[{_AR_LETTER}])")
_INVISIBLE = re.compile("[​﻿‎‏‪-‮⁦-⁩­]")
_MULTI_ZWNJ = re.compile(f"{ZWNJ}{{2,}}")
_ZWNJ_SPACE = re.compile(rf"[ \t]*{ZWNJ}[ \t]+|[ \t]+{ZWNJ}[ \t]*|^{ZWNJ}+|{ZWNJ}+$", re.M)
_MI_PREFIX = re.compile(rf"(?<![\w{ZWNJ}])(ن?می) +(?=[{_AR_LETTER}])")
_QMARK = re.compile(r"(?<=[؀-ۿ‌])[ \t]*\?")
_SPACE_BEFORE_PUNCT = re.compile(r"[ \t]+(?=[؟،؛!])")
_HSPACE = re.compile(r"[^\S\n]+")
_NEWLINES = re.compile(r" *\n[\s]*")

_DIACRITICS = re.compile("[ً-ٰٟۖ-ۭ]")
_COMPARE_MAP = str.maketrans(
    {"أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ؤ": "و", "ئ": "ی", "ة": "ه", "ۀ": "ه", ZWNJ: ""}
)
_NON_WORD = re.compile(r"[^\w]+")


def normalize_text(s: str) -> str:
    """Canonical Persian form for display/storage. Keeps Persian digits.

    Whitespace runs collapse to one space; newlines (paragraph breaks) are kept
    but collapsed to a single "\\n".
    """
    if not s:
        return ""
    s = unicodedata.normalize("NFKC", s)
    s = s.translate(_LETTER_MAP)
    s = _INVISIBLE.sub("", s)
    s = _TATWEEL.sub("", s)
    s = _HSPACE.sub(" ", s)
    s = _MULTI_ZWNJ.sub(ZWNJ, s)
    s = _ZWNJ_SPACE.sub(lambda m: "" if m.group(0).strip(" \t") == m.group(0) else " ", s)
    s = _MI_PREFIX.sub(lambda m: m.group(1) + ZWNJ, s)
    s = _QMARK.sub("؟", s)
    s = _SPACE_BEFORE_PUNCT.sub("", s)
    s = _NEWLINES.sub("\n", s)
    return s.strip()


def to_ascii_digits(s: str) -> str:
    return s.translate(_TO_ASCII)


def to_persian_digits(s: str | int) -> str:
    return str(s).translate(_TO_PERSIAN)


def comparable(s: str) -> str:
    """Aggressive form for equality/containment checks (never shown to users)."""
    s = normalize_text(s)
    s = to_ascii_digits(s).translate(_COMPARE_MAP)
    s = _DIACRITICS.sub("", s)
    s = s.replace("ـ", "")
    s = _NON_WORD.sub(" ", s).replace("_", " ")
    return " ".join(s.lower().split())
