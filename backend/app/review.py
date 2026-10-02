"""Review helpers shared by the API and the job runner: validation, auto-approval,
duplicate detection, the cross-project review queue and quick key entry."""

from __future__ import annotations

import re

from .models import Project
from .store import Store

QUEUE_LEVEL_ORDER = {"error": 0, "warning": 1, "pending": 2}
_LETTER_KEYS = {"الف": "1", "ب": "2", "ج": "3", "د": "4", "a": "1", "b": "2", "c": "3", "d": "4"}
_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")


def has_explanations(project: Project) -> bool:
    return any(d.kind == "explanations" for d in project.documents)


def revalidate(project: Project) -> None:
    from .blueprints import get_blueprint
    from .validate import validate_project, validate_question

    has_expl = has_explanations(project)
    for question in project.questions:
        question.issues = validate_question(question, has_expl)
    blueprint = get_blueprint(project.blueprint)
    expected = blueprint["question_count"] if blueprint else None
    project.issues = validate_project(project.questions, has_expl, expected)


def _is_clean(question, has_expl: bool) -> bool:
    try:
        from .validate import is_clean
    except ImportError:  # validator without the shared rule: be conservative
        return (
            bool(question.stem)
            and len(question.options) == 4
            and all(o.text for o in question.options)
            and question.correct_key in {"1", "2", "3", "4"}
            and not question.flags
            and not question.issues
        )
    return is_clean(question, has_expl)


def auto_approve(project: Project) -> int:
    """Approve every clean, not-yet-approved question. Returns how many were approved."""
    if project.mode != "questions":
        return 0
    has_expl = has_explanations(project)
    approved = 0
    for question in project.questions:
        if question.status != "approved" and _is_clean(question, has_expl):
            question.status = "approved"
            question.approved_by = "auto"
            approved += 1
    return approved


def detect_duplicates(project: Project, store: Store) -> None:
    """Compare against this project and every other question-mode project."""
    if project.mode != "questions" or not project.questions:
        return
    try:
        from .duplicates import find_duplicates
    except ImportError:
        return
    others = [p for p in store.list() if p.id != project.id and p.mode == "questions"]
    find_duplicates(project, others)


def queue_items(store: Store, limit: int = 200, project_id: str | None = None) -> list[dict]:
    """Questions needing attention across all ready projects, errors first."""
    items = []
    for project in store.list():
        if project.status != "ready" or project.mode != "questions":
            continue
        if project_id and project.id != project_id:
            continue
        for question in project.questions:
            if question.status == "approved":
                continue
            levels = {i.level for i in question.issues}
            if "error" in levels:
                level = "error"
            elif levels or question.flags:
                level = "warning"
            else:
                level = "pending"
            items.append(
                {
                    "project_id": project.id,
                    "project_title": project.title,
                    "number": question.number,
                    "level": level,
                    "codes": sorted({i.code for i in question.issues}),
                    "flags": len(question.flags),
                    "_created": project.created_at,
                }
            )
    items.sort(key=lambda i: (QUEUE_LEVEL_ORDER[i["level"]], i["_created"], i["number"]))
    for item in items:
        del item["_created"]
    return items[:limit]


def parse_keys(text: str) -> list[str | None]:
    """«۲۴۱۳ ۳۱-۲» → ["2","4","1","3",None?...]. 1–4 = key; 0, "-", "_", "." = skip.

    Without separators every character is one answer; with whitespace-separated
    tokens, letter answers (الف ب ج د) are accepted too.
    """
    text = text.translate(_DIGITS).strip().lower()
    tokens = text.split()
    if len(tokens) > 1 and any(t in _LETTER_KEYS for t in tokens):
        return [_LETTER_KEYS.get(t, t if t in {"1", "2", "3", "4"} else None) for t in tokens]
    chars = re.sub(r"[\s,،|/]+", "", text)
    out: list[str | None] = []
    for ch in chars:
        if ch in "1234":
            out.append(ch)
        elif ch in "0-_.?؟x":
            out.append(None)
        else:
            raise ValueError(f"نویسه‌ی «{ch}» در کلید معتبر نیست؛ فقط ۱ تا ۴ و «-» برای رد کردن.")
    return out


def apply_keys(project: Project, keys: list[str | None], start: int) -> int:
    """Set keys for questions start, start+1, … Returns how many keys were set."""
    by_number = {q.number: q for q in project.questions}
    changed = 0
    for offset, key in enumerate(keys):
        question = by_number.get(start + offset)
        if question is None or key is None:
            continue
        if question.correct_key != key:
            question.correct_key = key
            question.key_source = "manual"
            question.edited = True
            if question.status == "approved" and question.approved_by == "auto":
                question.status = "pending"
                question.approved_by = None
            changed += 1
    return changed
