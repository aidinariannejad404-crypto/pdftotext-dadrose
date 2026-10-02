"""Subjects and exam blueprints, copied from dadrose-quiz (content/subjects.py,
exams/blueprint_seed.py). Keys/codes must stay identical to the site's."""

from __future__ import annotations

import re
from functools import lru_cache

from .normalize import comparable

SUBJECTS: list[dict] = [
    {"key": "civil", "name": "حقوق مدنی", "aliases": ["مدنی"]},
    {"key": "civil_procedure", "name": "آیین دادرسی مدنی", "aliases": ["آ.د.م", "دادرسی مدنی"]},
    {"key": "commercial", "name": "حقوق تجارت", "aliases": ["تجارت"]},
    {"key": "usul_fiqh", "name": "اصول فقه", "aliases": ["اصول"]},
    {
        "key": "fiqh_bar",
        "name": "متون فقه کانون وکلا",
        "aliases": ["متون فقه کانون", "متون فقه کانون وکلای دادگستری"],
    },
    {"key": "criminal", "name": "حقوق جزا", "aliases": ["جزا", "حقوق کیفری"]},
    {"key": "criminal_procedure", "name": "آیین دادرسی کیفری", "aliases": ["آ.د.ک", "دادرسی کیفری"]},
    {"key": "constitutional", "name": "حقوق اساسی", "aliases": ["اساسی"]},
    {
        "key": "fiqh_center",
        "name": "متون فقه مرکز وکلا",
        "aliases": ["متون فقه مرکز", "متون فقه مرکز وکلای قوه قضاییه"],
    },
    {
        "key": "registration_law",
        "name": "حقوق ثبت مرکز وکلا",
        "aliases": ["حقوق ثبت", "ثبت", "حقوق ثبت مرکز"],
    },
]

SUBJECT_KEYS = [s["key"] for s in SUBJECTS]

_BAR_RANGES = [
    (1, 20, "civil"),
    (21, 40, "civil_procedure"),
    (41, 60, "commercial"),
    (61, 70, "usul_fiqh"),
    (71, 80, "fiqh_bar"),
    (81, 100, "criminal"),
    (101, 120, "criminal_procedure"),
    (121, 140, "constitutional"),
]
_CENTER_1404_RANGES = [
    (1, 20, "civil"),
    (21, 40, "civil_procedure"),
    (41, 60, "commercial"),
    (61, 80, "criminal"),
    (81, 95, "criminal_procedure"),
    (96, 110, "fiqh_center"),
    (111, 125, "registration_law"),
    (126, 135, "constitutional"),
]
_CENTER_1402_RANGES = [
    (1, 20, "civil"),
    (21, 40, "civil_procedure"),
    (41, 60, "commercial"),
    (61, 80, "criminal"),
    (81, 100, "criminal_procedure"),
    (101, 110, "fiqh_center"),
    (111, 120, "registration_law"),
    (121, 130, "constitutional"),
]

# Each: code, title, track, year, question_count, ranges [(from, to, subject_key)] (inclusive).
BLUEPRINTS: list[dict] = [
    {
        "code": "BAR-1405",
        "title": "آزمون ورودی کارآموزی کانون وکلا ۱۴۰۵",
        "track": "bar",
        "year": 1405,
        "question_count": 140,
        "ranges": _BAR_RANGES,
    },
    {
        "code": "CENTER-1404",
        "title": "آزمون وکالت مرکز وکلا ۱۴۰۴",
        "track": "center",
        "year": 1404,
        "question_count": 135,
        "ranges": _CENTER_1404_RANGES,
    },
    {
        "code": "CENTER-1405",
        "title": "آزمون وکالت مرکز وکلا ۱۴۰۵",
        "track": "center",
        "year": 1405,
        "question_count": 135,
        "ranges": list(_CENTER_1404_RANGES),
    },
    {
        "code": "CENTER-1402",
        "title": "آزمون وکالت مرکز وکلا ۱۴۰۲ (بازسازی)",
        "track": "center",
        "year": 1402,
        "question_count": 130,
        "ranges": _CENTER_1402_RANGES,
    },
]


def get_blueprint(code: str | None) -> dict | None:
    return next((b for b in BLUEPRINTS if b["code"] == code), None)


def subject_for(blueprint_code: str | None, number: int) -> str | None:
    blueprint = get_blueprint(blueprint_code)
    if blueprint is None:
        return None
    for start, end, key in blueprint["ranges"]:
        if start <= number <= end:
            return key
    return None


def blueprint_list() -> list[dict]:
    """Blueprint summaries for GET /api/meta."""
    fields = ("code", "title", "track", "year", "question_count")
    return [{f: b[f] for f in fields} for b in BLUEPRINTS]


# Words that may surround a subject name in a section heading ("بخش اول: حقوق مدنی (سؤالات ۱ تا ۲۰)").
_HEADING_FILLER = {
    "درس",
    "بخش",
    "قسمت",
    "مبحث",
    "دروس",
    "سوال",
    "سوالات",
    "سوالهای",
    "سوالها",
    "از",
    "تا",
    "شماره",
    "اول",
    "دوم",
    "سوم",
    "چهارم",
    "پنجم",
    "ششم",
    "هفتم",
    "هشتم",
    "نهم",
    "دهم",
}


@lru_cache(maxsize=1)
def _heading_index() -> dict[str, str]:
    index: dict[str, str] = {}
    for subject in SUBJECTS:
        for name in [subject["name"], *subject["aliases"]]:
            index[comparable(name)] = subject["key"]
            # "آ.د.م" style abbreviations lose their dots in comparable(); also index the joined form.
            index[comparable(name).replace(" ", "")] = subject["key"]
    # Combined BAR heading ("اصول فقه و متون فقه") starts with usul.
    index[comparable("اصول فقه و متون فقه")] = "usul_fiqh"
    return index


def detect_subject_heading(text: str) -> str | None:
    """Subject key when `text` is a short heading naming exactly one subject."""
    words = comparable(text).split()
    if not words or len(words) > 10:
        return None
    kept = [w for w in words if w not in _HEADING_FILLER and not re.fullmatch(r"\d+", w)]
    if not kept or len(kept) > 6:
        return None
    return _heading_index().get(" ".join(kept))
