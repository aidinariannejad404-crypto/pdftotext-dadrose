"""Export reviewed questions in the shape dadrose-quiz imports (see docs/ARCHITECTURE.md)."""

from __future__ import annotations

import html

import httpx

from .config import Settings
from .models import Project, Question

IMPORT_PATH = "/api/v1/admin/questions/import"


class DadroseError(RuntimeError):
    """Push to the DADROSE site failed; the message is Persian and safe to show."""


def _paragraphs(text: str) -> str:
    parts = [p.strip() for p in text.split("\n") if p.strip()]
    return "".join(f"<p>{html.escape(p)}</p>" for p in parts)


def _question_payload(q: Question) -> dict:
    options = sorted(q.options, key=lambda o: o.key)
    return {
        "source_number": q.number,
        "subject_key": q.subject_key,
        "stem_html": _paragraphs(q.stem),
        "options": [
            {"key": o.key, "order": order, "text_html": html.escape(o.text.strip())}
            for order, o in enumerate(options, start=1)
        ],
        "correct_key": q.correct_key,
        "explanation_html": _paragraphs(q.explanation),
    }


def to_dadrose_payload(project: Project, only_approved: bool) -> dict:
    questions = sorted(project.questions, key=lambda q: q.number)
    if only_approved:
        questions = [q for q in questions if q.status == "approved"]
    return {
        "source": {
            "kind": "official",
            "track": project.track,
            "year": project.year,
            "title": project.title,
        },
        "questions": [_question_payload(q) for q in questions],
    }


def push_to_dadrose(payload: dict, settings: Settings) -> dict:
    if not settings.dadrose_api_url or not settings.dadrose_api_token:
        raise DadroseError(
            "اتصال به سایت دادرس تنظیم نشده است (DADROSE_API_URL و DADROSE_API_TOKEN)."
        )
    url = settings.dadrose_api_url.rstrip("/") + IMPORT_PATH
    try:
        response = httpx.post(
            url,
            json=payload,
            headers={"Authorization": f"Bearer {settings.dadrose_api_token}"},
            timeout=60.0,
        )
    except httpx.HTTPError as exc:
        raise DadroseError(f"ارتباط با سایت دادرس برقرار نشد: {exc}") from exc
    if not response.is_success:
        detail = response.text[:300]
        raise DadroseError(f"سایت دادرس خطا برگرداند (کد {response.status_code}): {detail}")
    try:
        data = response.json()
    except ValueError:
        return {"text": response.text}
    return data if isinstance(data, dict) else {"data": data}
