"""Optional AI pass for subject / topic / article classification (Claude or Gemini).

Questions are sent in batches; the model answers JSON (structured outputs where the
API supports it). Results get source "ai"; fields an admin set ("manual") are kept.
"""

from __future__ import annotations

import json
import logging
import re

import anthropic
import httpx

from .blueprints import SUBJECT_KEYS, SUBJECTS
from .classify import law_key_for_name, load_laws, topics_by_subject
from .config import Settings
from .models import ArticleRef, Question
from .normalize import normalize_text, to_persian_digits
from .ocr.llm import AiEngineError, claude_configured, gemini_configured

log = logging.getLogger(__name__)

BATCH_SIZE = 15
EXPLANATION_CHARS = 600

SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": ["questions"],
    "properties": {
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["number", "subject_key", "topic", "articles", "confidence"],
                "properties": {
                    "number": {"type": "integer"},
                    "subject_key": {"type": "string", "enum": [*SUBJECT_KEYS, "unknown"]},
                    "topic": {"type": "string"},
                    "articles": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["law", "kind", "number", "clause"],
                            "properties": {
                                "law": {"type": "string"},
                                "kind": {"type": "string", "enum": ["ماده", "اصل"]},
                                "number": {"type": "string"},
                                "clause": {"type": "string"},
                            },
                        },
                    },
                    "confidence": {"type": "number"},
                },
            },
        }
    },
}


def _instructions(taxonomy: dict[str, list[str]]) -> str:
    subjects = "\n".join(f"- {s['key']}: {s['name']}" for s in SUBJECTS)
    topics = "\n".join(f"- {key}: {'، '.join(names)}" for key, names in taxonomy.items() if names)
    laws = "، ".join(law.name for law in load_laws().values())
    return f"""\
تو دستیار دسته‌بندی سؤال‌های چهارگزینه‌ای آزمون‌های حقوقی ایران (وکالت، قضاوت، ارشد) هستی.
برای هر سؤال تعیین کن:
- subject_key: درس سؤال، فقط از این فهرست (اگر مطمئن نیستی "unknown"):
{subjects}
- topic: مبحث سؤال. در صورت امکان دقیقاً یکی از نام‌های این فهرست برای همان درس؛ اگر هیچ‌کدام مناسب نیست یک عنوان کوتاه فارسی بنویس:
{topics}
- articles: مواد/اصول قانونی که سؤال درباره‌ی آن است (فقط اگر با اطمینان می‌دانی؛ از متن سؤال و پاسخ تشریحی).
  law: نام کامل قانون (مثلاً «قانون مدنی»؛ قوانین شناخته‌شده: {laws})، kind: «ماده» یا «اصل»،
  number: شماره (مثلاً «۱۹۰» یا «۱۰ مکرر»)، clause: بند/تبصره در صورت وجود وگرنه "".
- confidence: عددی بین ۰ و ۱.
حدس‌های فعلی سیستم داده شده؛ اگر درست‌اند همان‌ها را برگردان.
خروجی فقط JSON با کلید questions باشد."""


def _payload(q: Question) -> dict:
    return {
        "number": q.number,
        "stem": q.stem,
        "options": {o.key: o.text for o in q.options},
        "explanation": q.explanation[:EXPLANATION_CHARS],
        "current_guess": {
            "subject_key": q.subject_key,
            "topic": q.topic,
            "articles": [f"{a.kind} {a.number} {a.law}".strip() for a in q.articles[:5]],
            "section_path": q.classification.section_path,
        },
    }


def _parse_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise AiEngineError("پاسخ هوش مصنوعی JSON معتبر نبود.")
    try:
        data = json.loads(text[start : end + 1])
    except ValueError as exc:
        raise AiEngineError("پاسخ هوش مصنوعی JSON معتبر نبود.") from exc
    if not isinstance(data, dict) or not isinstance(data.get("questions"), list):
        raise AiEngineError("پاسخ هوش مصنوعی ساختار مورد انتظار را نداشت.")
    return data


# --------------------------------------------------------------------- engines


class _Claude:
    def __init__(self, settings: Settings, client: anthropic.Anthropic | None = None) -> None:
        self.settings = settings
        self.client = client or anthropic.Anthropic(
            api_key=settings.anthropic_api_key or None,
            base_url=settings.anthropic_base_url or None,
            timeout=settings.ai_timeout_seconds,
            max_retries=3,
        )
        self._structured = True

    def _create(self, prompt: str):
        s = self.settings
        common = {
            "model": s.claude_model,
            "max_tokens": 16000,
            "messages": [{"role": "user", "content": prompt}],
        }
        if self._structured:
            try:
                return self.client.messages.create(
                    **common,
                    output_config={
                        "effort": s.claude_effort,
                        "format": {"type": "json_schema", "schema": SCHEMA},
                    },
                )
            except anthropic.BadRequestError as exc:
                msg = str(exc).lower()
                if "format" not in msg and "schema" not in msg and "output_config" not in msg:
                    raise
                log.warning("Claude rejected structured output; asking for JSON in the prompt")
                self._structured = False
        return self.client.messages.create(**common, output_config={"effort": s.claude_effort})

    def ask(self, prompt: str) -> dict:
        try:
            response = self._create(prompt)
        except anthropic.RateLimitError as exc:
            raise AiEngineError("محدودیت تعداد درخواست Claude؛ کمی بعد دوباره تلاش کنید.") from exc
        except anthropic.APIStatusError as exc:
            if exc.status_code in (401, 403):
                raise AiEngineError("کلید API برای Claude نامعتبر است یا دسترسی ندارد.") from exc
            raise AiEngineError(f"خطای سرویس Claude (کد {exc.status_code}).") from exc
        except anthropic.APIConnectionError as exc:
            raise AiEngineError(
                "اتصال به سرویس Claude برقرار نشد (شبکه/پراکسی را بررسی کنید)."
            ) from exc
        if response.stop_reason == "refusal":
            raise AiEngineError("Claude از دسته‌بندی این سؤال‌ها خودداری کرد.")
        text = "".join(b.text for b in response.content if getattr(b, "type", None) == "text")
        return _parse_json(text)


class _Gemini:
    def __init__(self, settings: Settings, client: httpx.Client | None = None) -> None:
        self.settings = settings
        self.client = client or httpx.Client(timeout=settings.ai_timeout_seconds)

    def ask(self, prompt: str) -> dict:
        s = self.settings
        url = f"{s.gemini_base_url.rstrip('/')}/v1beta/models/{s.gemini_model}:generateContent"
        body = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
        }
        try:
            r = self.client.post(url, json=body, headers={"x-goog-api-key": s.gemini_api_key})
        except httpx.HTTPError as exc:
            raise AiEngineError(
                "اتصال به سرویس Gemini برقرار نشد (شبکه/پراکسی را بررسی کنید)."
            ) from exc
        if r.status_code == 429:
            raise AiEngineError("محدودیت تعداد درخواست Gemini؛ کمی بعد دوباره تلاش کنید.")
        if r.status_code in (401, 403):
            raise AiEngineError("کلید API برای Gemini نامعتبر است یا دسترسی ندارد.")
        if r.status_code >= 400:
            raise AiEngineError(f"خطای سرویس Gemini (کد {r.status_code}).")
        try:
            parts = r.json()["candidates"][0].get("content", {}).get("parts", [])
        except (ValueError, KeyError, IndexError) as exc:
            raise AiEngineError("پاسخ Gemini قابل خواندن نبود یا خالی بود.") from exc
        return _parse_json("".join(p.get("text", "") for p in parts))


def _engine(engine_name: str, settings: Settings, client=None):
    if engine_name == "claude":
        if client is None and not claude_configured(settings):
            raise AiEngineError("Claude پیکربندی نشده است (ANTHROPIC_API_KEY).")
        return _Claude(settings, client)
    if engine_name == "gemini":
        if client is None and not gemini_configured(settings):
            raise AiEngineError("Gemini پیکربندی نشده است (GEMINI_API_KEY).")
        return _Gemini(settings, client)
    raise AiEngineError(f"موتور «{engine_name}» برای دسته‌بندی پشتیبانی نمی‌شود.")


# ------------------------------------------------------------------------ apply


def _to_ref(item: dict) -> ArticleRef | None:
    number = to_persian_digits(normalize_text(str(item.get("number", "")))).strip()
    if not number:
        return None
    law = normalize_text(str(item.get("law", "")))
    kind = "اصل" if item.get("kind") == "اصل" else "ماده"
    key = law_key_for_name(law) if law else ("constitution" if kind == "اصل" else None)
    laws = load_laws()
    return ArticleRef(
        law_key=key,
        law=laws[key].name if key in laws else law,
        kind=kind,  # type: ignore[arg-type]
        number=number,
        clause=to_persian_digits(normalize_text(str(item.get("clause", "")))),
        source="ai",
    )


def _apply(q: Question, item: dict) -> None:
    c = q.classification
    confidence = item.get("confidence")
    confidence = (
        max(0.0, min(1.0, float(confidence))) if isinstance(confidence, int | float) else None
    )
    subject = item.get("subject_key")
    if c.subject_source != "manual" and subject in SUBJECT_KEYS:
        q.subject_key, c.subject_source, c.subject_confidence = subject, "ai", confidence
    topic = normalize_text(str(item.get("topic") or ""))
    if c.topic_source != "manual" and topic:
        known = {t.name for t in topics_by_subject().get(q.subject_key or "", [])}
        q.topic, c.topic_source = topic, "ai"
        c.topic_confidence = confidence if topic in known else min(confidence or 0.5, 0.6)
    if not any(r.source == "manual" for r in q.articles):
        refs = [r for r in (_to_ref(a) for a in item.get("articles") or []) if r]
        kept = [r for r in q.articles if r.source == "text"]  # literal citations stay
        seen = {(r.law_key or r.law, r.kind, r.number, r.clause) for r in kept}
        for ref in refs:
            key = (ref.law_key or ref.law, ref.kind, ref.number, ref.clause)
            if key not in seen:
                seen.add(key)
                kept.append(ref)
        q.articles = kept


def classify_with_ai(
    questions: list[Question],
    engine_name: str,
    settings: Settings,
    taxonomy: dict[str, list[str]] | None = None,
    *,
    client=None,
) -> None:
    """Refine subject/topic/articles with Claude or Gemini (mutates `questions`)."""
    if not questions:
        return
    engine = _engine(engine_name, settings, client)
    taxonomy = taxonomy or {s: [t.name for t in ts] for s, ts in topics_by_subject().items()}
    head = _instructions(taxonomy)
    by_number = {q.number: q for q in questions}
    for start in range(0, len(questions), BATCH_SIZE):
        batch = questions[start : start + BATCH_SIZE]
        prompt = (
            head
            + "\n\nسؤال‌ها:\n"
            + json.dumps({"questions": [_payload(q) for q in batch]}, ensure_ascii=False)
        )
        data = engine.ask(prompt)
        for item in data["questions"]:
            if isinstance(item, dict) and isinstance(item.get("number"), int):
                q = by_number.get(item["number"])
                if q is not None:
                    _apply(q, item)
