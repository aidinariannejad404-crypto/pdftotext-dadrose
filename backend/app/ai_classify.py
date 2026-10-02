"""Optional AI pass for subject / topic / article classification (Claude or Gemini).

Questions are sent in batches; the model answers JSON (structured outputs where the
API supports it). Results get source "ai"; fields an admin set ("manual") are kept.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path

import anthropic
import httpx

from .blueprints import SUBJECT_KEYS, SUBJECTS
from .classify import law_key_for_name, load_laws, topics_by_subject
from .config import Settings
from .models import AiUsage, ArticleRef, Question
from .normalize import normalize_text, to_persian_digits
from .ocr.llm import AiEngineError, claude_configured, gemini_configured

log = logging.getLogger(__name__)

BATCH_SIZE = 25
STEM_CHARS = 400
OPTION_CHARS = 120
EXPLANATION_CHARS = 300
CONFIDENT = 0.6  # rules results at or above this are not sent to the AI
PROMPT_VERSION = "classify-v2"  # bump when the prompt/schema changes (invalidates the cache)

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
    """Prompt head; `taxonomy` holds only the topics of the batch's likely subjects."""
    subjects = "، ".join(f"{s['key']}={s['name']}" for s in SUBJECTS)
    topics = "\n".join(f"- {key}: {'، '.join(names)}" for key, names in taxonomy.items() if names)
    topics_part = f" فهرست مباحث:\n{topics}" if topics else ""
    return f"""\
سؤال‌های چهارگزینه‌ای آزمون حقوقی ایران را دسته‌بندی کن. برای هر سؤال:
- subject_key: یکی از {subjects} (یا "unknown").
- topic: مبحث؛ در صورت امکان دقیقاً یکی از نام‌های فهرست همان درس، وگرنه عنوان کوتاه فارسی.{topics_part}
- articles: مواد/اصولی که سؤال درباره‌ی آن است، فقط با اطمینان: law (نام کامل قانون)، \
kind («ماده»/«اصل»)، number، clause (بند/تبصره یا "").
- confidence: ۰ تا ۱.
guess حدس فعلی سیستم است. خروجی فقط JSON با کلید questions."""


def _clip(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _payload(q: Question) -> dict:
    return {
        "number": q.number,
        "stem": _clip(q.stem, STEM_CHARS),
        "options": [_clip(o.text, OPTION_CHARS) for o in q.options],
        "explanation": _clip(q.explanation, EXPLANATION_CHARS),
        "refs": [f"{a.kind} {a.number} {a.law}".strip() for a in q.articles[:5]],
        "guess": {
            "subject": q.subject_key,
            "topic": q.topic,
            "headings": q.classification.section_path[-2:],
        },
    }


def needs_ai(q: Question) -> bool:
    """True when the rules left the subject or topic missing / uncertain (< 0.6).

    Fields an admin set ("manual") never count; a topic only counts when the
    question's subject has taxonomy topics (or the subject itself is unknown)."""
    c = q.classification
    need_subject = c.subject_source != "manual" and (
        not q.subject_key or (c.subject_confidence or 0.0) < CONFIDENT
    )
    has_topics = not q.subject_key or bool(topics_by_subject().get(q.subject_key))
    need_topic = (
        c.topic_source != "manual"
        and has_topics
        and (not q.topic or (c.topic_confidence or 0.0) < CONFIDENT)
    )
    return need_subject or need_topic


# ------------------------------------------------------------------------ cache


class _Cache:
    """Tiny JSON-file cache: one file per answer, keyed by a sha256 hex digest."""

    def __init__(self, settings: Settings) -> None:
        self.dir = Path(settings.data_dir) / "ai-cache" / "classify"
        self.enabled = bool(getattr(settings, "ai_cache", True))

    @staticmethod
    def key(provider: str, model: str, payload: dict) -> str:
        blob = json.dumps(
            [provider, model, PROMPT_VERSION, payload], ensure_ascii=False, sort_keys=True
        )
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def _path(self, key: str) -> Path:
        return self.dir / key[:2] / f"{key}.json"

    def get(self, key: str) -> dict | None:
        if not self.enabled:
            return None
        try:
            data = json.loads(self._path(key).read_text("utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    def put(self, key: str, value: dict) -> None:
        if not self.enabled:
            return
        path = self._path(key)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(value, ensure_ascii=False), "utf-8")
            tmp.replace(path)
        except OSError as exc:  # a cache failure must never fail the classification
            log.warning("AI cache write failed: %s", exc)


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

    provider = "claude"

    @property
    def model(self) -> str:
        return self.settings.claude_model

    def _create(self, prompt: str, max_tokens: int):
        s = self.settings
        effort = getattr(s, "ai_ocr_effort", "") or s.claude_effort
        common = {
            "model": s.claude_model,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        }
        if self._structured:
            try:
                return self.client.messages.create(
                    **common,
                    output_config={
                        "effort": effort,
                        "format": {"type": "json_schema", "schema": SCHEMA},
                    },
                )
            except anthropic.BadRequestError as exc:
                msg = str(exc).lower()
                if "format" not in msg and "schema" not in msg and "output_config" not in msg:
                    raise
                log.warning("Claude rejected structured output; asking for JSON in the prompt")
                self._structured = False
        return self.client.messages.create(**common, output_config={"effort": effort})

    def ask(self, prompt: str, max_tokens: int) -> tuple[dict, AiUsage]:
        try:
            response = self._create(prompt, max_tokens)
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
        usage = getattr(response, "usage", None)
        spent = AiUsage(
            calls=1,
            input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
            output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
        )
        if response.stop_reason == "max_tokens":
            log.warning("Claude classification hit max_tokens; trying to parse what came back")
        return _parse_json(text), spent


class _Gemini:
    def __init__(self, settings: Settings, client: httpx.Client | None = None) -> None:
        self.settings = settings
        self.client = client or httpx.Client(timeout=settings.ai_timeout_seconds)

    provider = "gemini"

    @property
    def model(self) -> str:
        return self.settings.gemini_model

    def ask(self, prompt: str, max_tokens: int) -> tuple[dict, AiUsage]:
        # max_tokens is not forwarded: Gemini 2.5 counts thinking tokens against it.
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
            data = r.json()
            parts = data["candidates"][0].get("content", {}).get("parts", [])
        except (ValueError, KeyError, IndexError) as exc:
            raise AiEngineError("پاسخ Gemini قابل خواندن نبود یا خالی بود.") from exc
        meta = data.get("usageMetadata") or {}
        spent = AiUsage(
            calls=1,
            input_tokens=int(meta.get("promptTokenCount", 0) or 0),
            output_tokens=int(meta.get("candidatesTokenCount", 0) or 0)
            + int(meta.get("thoughtsTokenCount", 0) or 0),
        )
        return _parse_json("".join(p.get("text", "") for p in parts)), spent


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
    only_uncertain: bool = True,
    *,
    taxonomy: dict[str, list[str]] | None = None,
    client=None,
) -> AiUsage:
    """Refine subject/topic/articles with Claude or Gemini (mutates `questions`).

    With `only_uncertain` (default) only questions the rules could not settle are
    sent (see `needs_ai`). Answers are cached on disk per question payload, so a
    re-run costs nothing. Returns the token usage of the calls actually made.
    """
    usage = AiUsage()
    targets = [q for q in questions if needs_ai(q)] if only_uncertain else list(questions)
    targets = [
        q
        for q in targets
        if not (
            q.classification.subject_source == "manual"
            and q.classification.topic_source == "manual"
        )
    ]
    if not targets:
        return usage
    engine = _engine(engine_name, settings, client)
    cache = _Cache(settings)
    all_topics = taxonomy or {s: [t.name for t in ts] for s, ts in topics_by_subject().items()}

    pending: list[tuple[Question, dict, str]] = []
    for q in targets:
        payload = _payload(q)
        key = cache.key(engine.provider, engine.model, payload)
        cached = cache.get(key)
        if cached is not None:
            _apply(q, cached)
            usage.cached += 1
        else:
            pending.append((q, payload, key))

    for start in range(0, len(pending), BATCH_SIZE):
        batch = pending[start : start + BATCH_SIZE]
        subjects = {q.subject_key for q, _, _ in batch if q.subject_key}
        prompt = (
            _instructions({s: all_topics.get(s, []) for s in sorted(subjects)})
            + "\n\n"
            + json.dumps({"questions": [p for _, p, _ in batch]}, ensure_ascii=False)
        )
        data, spent = engine.ask(prompt, max_tokens=120 * len(batch) + 300)
        usage.add(spent)
        by_number = {q.number: (q, key) for q, _, key in batch}
        for item in data["questions"]:
            if isinstance(item, dict) and isinstance(item.get("number"), int):
                match = by_number.get(item["number"])
                if match is not None:
                    _apply(match[0], item)
                    cache.put(match[1], item)
    return usage
