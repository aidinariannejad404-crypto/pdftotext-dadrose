"""Per-question and per-project checks. Messages are Persian; codes are stable."""

from __future__ import annotations

import re
import statistics
from collections import Counter

from .models import Issue, Question
from .normalize import normalize_text, to_ascii_digits, to_persian_digits

OPTION_KEYS = ("1", "2", "3", "4")

_KEY_WORDS = {
    "الف": "1",
    "ب": "2",
    "ج": "3",
    "د": "4",
    "یک": "1",
    "اول": "1",
    "دو": "2",
    "دوم": "2",
    "سه": "3",
    "سوم": "3",
    "چهار": "4",
    "چهارم": "4",
}
_KEY_VALUE = r"[«\"'(\[]?\s*([1-4]|الف|چهارم|چهار|سوم|دوم|اول|یک|سه|دو|ب|ج|د)(?![\w])"
_STATED_KEY = [
    re.compile(r"گزینه[‌\s]*(?:ی\s*)?(?:شماره\s*)?" + _KEY_VALUE),
    re.compile(r"(?:پاسخ|جواب)\s*(?:صحیح|درست)?\s*[:：]?\s*(?:گزینه\s*)?" + _KEY_VALUE),
]


def stated_key(explanation: str, window: int = 200) -> str | None:
    """The correct option an explanation states near its beginning ("گزینه ۳ صحیح است")."""
    head = to_ascii_digits(normalize_text(explanation[: window * 2]))[:window]
    best: tuple[int, str] | None = None
    for pattern in _STATED_KEY:
        m = pattern.search(head)
        if m and (best is None or m.start() < best[0]):
            value = m.group(1)
            best = (m.start(), _KEY_WORDS.get(value, value))
    return best[1] if best else None


def _issue(level: str, code: str, message: str, field: str | None = None) -> Issue:
    return Issue(level=level, code=code, message=message, field=field)  # type: ignore[arg-type]


def _fa_list(values) -> str:
    return "، ".join(to_persian_digits(v) for v in values)


# A marker that looks like the start of another option ("۲) ", "ج) ") inside a field.
_INNER_MARKER = re.compile(r"(?:^|\s)\(?([1-4]|الف|ب|ج|د)\s*[)\-]\s*(?=[^\W\d])")
_GUARD_WORDS = {"ماده", "مواد", "بند", "تبصره", "اصل", "فصل", "جزء", "قسمت", "فقره", "شماره"}


def _inner_markers(text: str) -> list[str]:
    text = to_ascii_digits(text)
    found = []
    for m in _INNER_MARKER.finditer(text):
        before = text[: m.start()].split()
        if before and before[-1] in _GUARD_WORDS:
            continue
        found.append(m.group(1))
    return found


def _merged_suspects(q: Question) -> list[Issue]:
    issues: list[Issue] = []
    stem_markers = [m for m in _inner_markers(q.stem) if m.isdigit()]
    next_number = re.search(rf"(?:^|\s){q.number + 1}\s*[-.)]\s", to_ascii_digits(q.stem) + " ")
    if ("1" in stem_markers and "2" in stem_markers) or next_number:
        issues.append(
            _issue(
                "warning",
                "merged_suspect",
                "به نظر می‌رسد گزینه‌ها یا سؤال بعدی در صورت سؤال ادغام شده‌اند.",
                "stem",
            )
        )
    for option in q.options:
        others = [len(o.text) for o in q.options if o is not option and o.text]
        median = statistics.median(others) if others else 0
        too_long = len(option.text) > 400 or (median and len(option.text) > max(150, 4 * median))
        if _inner_markers(option.text) or too_long:
            issues.append(
                _issue(
                    "warning",
                    "merged_suspect",
                    f"گزینه {to_persian_digits(option.key)} احتمالاً با متن دیگری ادغام شده است.",
                    f"option:{option.key}",
                )
            )
    return issues


def validate_question(q: Question, has_explanations: bool) -> list[Issue]:
    issues: list[Issue] = []
    if not q.stem.strip():
        issues.append(_issue("error", "empty_stem", "صورت سؤال خالی است.", "stem"))

    keys = [o.key for o in q.options]
    missing = [k for k in OPTION_KEYS if k not in keys]
    extra = [k for k in keys if k not in OPTION_KEYS]
    if len(q.options) != 4 or missing or extra:
        message = f"تعداد گزینه‌ها {to_persian_digits(len(q.options))} است (باید ۴ باشد)."
        if missing:
            message += f" گزینه‌ی {_fa_list(missing)} پیدا نشد."
        if extra:
            message += f" گزینه‌ی اضافی: {_fa_list(extra)}."
        issues.append(_issue("error", "option_count", message))
    for option in q.options:
        if not option.text.strip():
            issues.append(
                _issue(
                    "error",
                    "empty_option",
                    f"متن گزینه {to_persian_digits(option.key)} خالی است.",
                    f"option:{option.key}",
                )
            )

    if not q.correct_key:
        issues.append(_issue("error", "missing_key", "کلید (گزینه صحیح) مشخص نیست."))
    elif q.correct_key not in OPTION_KEYS or (keys and q.correct_key not in keys):
        issues.append(
            _issue(
                "error",
                "invalid_key",
                f"کلید «{to_persian_digits(q.correct_key)}» با گزینه‌ها مطابقت ندارد.",
            )
        )
    elif q.key_source != "manual" and q.explanation:
        expl_key = stated_key(q.explanation)
        if expl_key and expl_key != q.correct_key:
            issues.append(
                _issue(
                    "error",
                    "key_mismatch",
                    f"کلید جدول ({to_persian_digits(q.correct_key)}) با پاسخ تشریحی "
                    f"(گزینه {to_persian_digits(expl_key)}) مغایرت دارد.",
                    "explanation",
                )
            )

    if has_explanations and not q.explanation.strip():
        issues.append(
            _issue("warning", "missing_explanation", "پاسخ تشریحی پیدا نشد.", "explanation")
        )
    if q.flags:
        issues.append(
            _issue(
                "warning",
                "suspicious_words",
                f"{to_persian_digits(len(q.flags))} کلمه مشکوک",
            )
        )
    issues.extend(_merged_suspects(q))
    if not q.subject_key:
        issues.append(_issue("warning", "missing_subject", "درس سؤال مشخص نیست."))
    return issues


def validate_project(
    questions: list[Question], has_explanations: bool, expected_count: int | None
) -> list[Issue]:
    issues: list[Issue] = []
    numbers = [q.number for q in questions]
    present = set(numbers)
    if present:
        upper = max(max(present), expected_count or 0)
        gaps = [n for n in range(1, upper + 1) if n not in present]
        if gaps:
            issues.append(_issue("error", "missing_numbers", f"سؤال‌های یافت‌نشده: {_compact(gaps)}"))
    dups = sorted(n for n, c in Counter(numbers).items() if c > 1)
    if dups:
        issues.append(_issue("error", "duplicate_numbers", f"شماره‌های تکراری: {_fa_list(dups)}"))
    if expected_count is not None and len(questions) != expected_count:
        issues.append(
            _issue(
                "warning",
                "count_mismatch",
                f"{to_persian_digits(len(questions))} سؤال پیدا شد؛ "
                f"الگوی آزمون {to_persian_digits(expected_count)} سؤال دارد.",
            )
        )
    if has_explanations and questions and not any(q.explanation for q in questions):
        issues.append(
            _issue(
                "warning",
                "explanations_unmatched",
                "هیچ پاسخ تشریحی با سؤال‌ها تطبیق داده نشد.",
            )
        )
    if questions and not any(q.key_source == "table" for q in questions):
        issues.append(
            _issue("warning", "key_table_missing", "جدول کلید سؤالات در دفترچه پیدا نشد.")
        )
    return issues


def _compact(numbers: list[int]) -> str:
    """[1,2,3,7] -> "۱–۳، ۷"."""
    parts: list[str] = []
    start = prev = numbers[0]
    for n in [*numbers[1:], None]:
        if n is not None and n == prev + 1:
            prev = n
            continue
        parts.append(
            to_persian_digits(start)
            if start == prev
            else f"{to_persian_digits(start)}–{to_persian_digits(prev)}"
        )
        if n is not None:
            start = prev = n
    return "، ".join(parts)
