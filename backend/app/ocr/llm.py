"""AI engines (Claude, Gemini) for Persian exam pages.

Two kinds of calls, both token-frugal (short English system prompt, grayscale JPEG input
prepared by the caller, per-mode output caps, low effort):

* `transcribe_ex(jpeg, mode)` — full transcription of a page or of a cropped region;
* `correct(jpeg, lines)` — proofread only the suspicious OCR lines shown in the image and
  return word-level corrections as JSON (output is a few dozen tokens).

Every call returns an `AiResult` with the provider-reported token usage. Network errors are
re-raised as `AiEngineError` with a Persian message.
"""

from __future__ import annotations

import base64
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

import anthropic
import httpx

from app.config import Settings
from app.models import AiUsage
from app.ocr.tesseract import tesseract_available

log = logging.getLogger(__name__)

Mode = Literal["page", "region"]
CallMode = Literal["page", "region", "correct"]

# Bump when prompts change so cached answers from older prompts are not reused.
PROMPT_VERSION = "2"
MAX_TOKENS: dict[str, int] = {"page": 8000, "region": 3000, "correct": 1500}

# English instructions: Persian text costs ~2–3× more tokens for the same content.
SYSTEM_OCR = (
    "You are a precise OCR engine for Persian (Farsi) law-exam pages. Output only the "
    "transcription: the exact printed text, with no corrections, translation, summary, "
    "commentary or markdown fences. Keep line breaks and reading order (RTL, top to bottom; "
    "in two-column pages the right column first). Keep question numbers and option markers "
    "exactly as printed (e.g. ۱۲- ، ۱) ، الف)). Use Persian ی and ک; keep half-spaces (ZWNJ). "
    "Tables: one row per line, cells separated by ' | '. Mark illegible parts as [؟]. "
    "Ignore scanner-app watermarks (CamScanner etc.), decorations and page numbers."
)
USER_PAGE = "Transcribe this page."
USER_REGION = (
    "Transcribe this cropped part of a page (usually one question with its options, or its "
    "explanation). Skip lines cut off at the edges unless they are legible."
)
SYSTEM_CORRECT = (
    "You proofread Persian OCR output against the image of the same lines. Report only real "
    "misreadings; never rephrase, complete or modernize text. Answer with JSON only."
)

CORRECTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "checked": {"type": "array", "items": {"type": "integer"}},
        "corrections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "line": {"type": "integer"},
                    "from": {"type": "string"},
                    "to": {"type": "string"},
                },
                "required": ["line", "from", "to"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["checked", "corrections"],
    "additionalProperties": False,
}

_FENCE_RE = re.compile(r"^\s*```[a-zA-Z]*\s*\n?|\n?\s*```\s*$")


def correction_prompt(lines: list[str]) -> str:
    """User text of a correction call. `lines` are already "index: text" with ⟦suspicious⟧
    words marked."""
    return (
        "The image shows these OCR lines (crops stacked top to bottom, separated by gray "
        "bars). Words in ⟦ ⟧ are suspicious; check them first, but report any misread word.\n"
        + "\n".join(lines)
        + '\n\nReturn {"checked": [indices of the lines you could verify in the image], '
        '"corrections": [{"line": index, "from": "OCR word copied exactly from that line '
        '(without ⟦ ⟧)", "to": "word as printed"}]}. Empty corrections if everything is right.'
    )


class AiEngineError(RuntimeError):
    """An AI engine call failed; `str(err)` is a Persian message fit for the UI."""


@dataclass
class AiResult:
    text: str = ""
    corrections: list[dict[str, Any]] = field(default_factory=list)
    checked: list[int] = field(default_factory=list)
    complete: bool = True  # False when the answer was truncated (max_tokens)
    usage: AiUsage = field(default_factory=AiUsage)

    def to_cache(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "corrections": self.corrections,
            "checked": self.checked,
            "complete": self.complete,
            "usage": self.usage.model_dump(),
        }

    @classmethod
    def from_cache(cls, data: dict[str, Any]) -> AiResult:
        # A cache hit is free: count it, but no tokens.
        return cls(
            text=data.get("text", ""),
            corrections=list(data.get("corrections", [])),
            checked=list(data.get("checked", [])),
            complete=bool(data.get("complete", True)),
            usage=AiUsage(cached=1),
        )


class AiEngine(Protocol):
    name: str
    model: str

    def transcribe_ex(self, jpeg: bytes, mode: Mode = "page") -> AiResult: ...

    def transcribe(self, jpeg: bytes, mode: Mode = "page") -> str: ...

    def correct(self, jpeg: bytes, lines: list[str]) -> AiResult: ...


def user_prompt(mode: Mode) -> str:
    return USER_REGION if mode == "region" else USER_PAGE


def clean_output(text: str) -> str:
    """Strip accidental markdown fences and surrounding whitespace."""
    text = text.strip()
    if text.startswith("```") or text.endswith("```"):
        text = _FENCE_RE.sub("", text).strip()
    return text


def parse_corrections(text: str) -> tuple[list[dict[str, Any]], list[int]]:
    """Parse a correction answer: {"checked": [...], "corrections": [...]} or a bare list.
    Malformed items are dropped; unparseable text raises AiEngineError."""
    raw = clean_output(text)
    try:
        data = json.loads(raw)
    except ValueError:
        m = re.search(r"[\[{].*[\]}]", raw, re.DOTALL)  # JSON wrapped in prose
        try:
            data = json.loads(m.group(0)) if m else None
        except ValueError:
            data = None
        if data is None:
            raise AiEngineError("پاسخ اصلاحی هوش مصنوعی JSON معتبر نبود.") from None
    checked: list[int] = []
    if isinstance(data, dict):
        checked = [c for c in data.get("checked", []) if isinstance(c, int)]
        items = data.get("corrections", [])
    else:
        items = data
    out = []
    for it in items if isinstance(items, list) else []:
        if (
            isinstance(it, dict)
            and isinstance(it.get("line"), int)
            and isinstance(it.get("from"), str)
            and isinstance(it.get("to"), str)
        ):
            out.append({"line": it["line"], "from": it["from"], "to": it["to"]})
    return out, checked


class _EngineBase:
    name = ""
    model = ""

    def transcribe(self, jpeg: bytes, mode: Mode = "page") -> str:
        """Backward-compatible text-only wrapper."""
        return self.transcribe_ex(jpeg, mode).text

    def transcribe_ex(self, jpeg: bytes, mode: Mode = "page") -> AiResult:  # pragma: no cover
        raise NotImplementedError


# --------------------------------------------------------------------------------- Claude


class ClaudeEngine(_EngineBase):
    name = "claude"

    def __init__(self, settings: Settings, client: anthropic.Anthropic | None = None) -> None:
        self.settings = settings
        self.model = settings.claude_model
        self.client = client or anthropic.Anthropic(
            api_key=settings.anthropic_api_key or None,
            base_url=settings.anthropic_base_url or None,
            timeout=settings.ai_timeout_seconds,
            max_retries=3,
        )
        self._use_beta = True
        self._use_format = True

    def _create(self, system: str, content: list[dict], max_tokens: int, schema: dict | None):
        output_config: dict[str, Any] = {"effort": self.settings.ai_ocr_effort}
        if schema is not None and self._use_format:
            output_config["format"] = {"type": "json_schema", "schema": schema}
        common = {
            "model": self.model,
            "max_tokens": max_tokens,
            "system": system,
            "output_config": output_config,
            "messages": [{"role": "user", "content": content}],
        }
        try:
            if self._use_beta:
                try:
                    return self.client.beta.messages.create(
                        **common, betas=["server-side-fallback-2026-07-01"], fallbacks="default"
                    )
                except anthropic.BadRequestError as exc:
                    msg = str(exc).lower()
                    if "fallback" not in msg and "beta" not in msg:
                        raise
                    # A relay that doesn't know the beta: retry without it, and remember.
                    log.warning("Claude relay rejected fallbacks beta; retrying without it")
                    self._use_beta = False
            return self.client.messages.create(**common)
        except anthropic.BadRequestError as exc:
            msg = str(exc).lower()
            if "format" in output_config and ("format" in msg or "schema" in msg):
                # Structured output unsupported here: fall back to prompt-only JSON.
                log.warning("Claude rejected structured output; using prompt JSON")
                self._use_format = False
                return self._create(system, content, max_tokens, None)
            raise

    def _call(self, jpeg: bytes, mode: CallMode, system: str, text: str, schema: dict | None):
        b64 = base64.standard_b64encode(jpeg).decode("ascii")
        content = [
            {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/jpeg", "data": b64},
            },
            {"type": "text", "text": text},
        ]
        try:
            response = self._create(system, content, MAX_TOKENS[mode], schema)
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
            raise AiEngineError("Claude از رونویسی این تصویر خودداری کرد.")
        out = "".join(b.text for b in response.content if getattr(b, "type", None) == "text")
        complete = response.stop_reason != "max_tokens"
        if not complete:
            log.warning("Claude %s call hit max_tokens; output is truncated", mode)
            if not out.strip():
                raise AiEngineError("پاسخ Claude ناقص ماند (سقف طول خروجی).")
        return out, complete, _claude_usage(response)

    def transcribe_ex(self, jpeg: bytes, mode: Mode = "page") -> AiResult:
        text, complete, usage = self._call(jpeg, mode, SYSTEM_OCR, user_prompt(mode), None)
        return AiResult(text=clean_output(text), complete=complete, usage=usage)

    def correct(self, jpeg: bytes, lines: list[str]) -> AiResult:
        text, complete, usage = self._call(
            jpeg, "correct", SYSTEM_CORRECT, correction_prompt(lines), CORRECTION_SCHEMA
        )
        corrections, checked = parse_corrections(text) if complete else ([], [])
        return AiResult(corrections=corrections, checked=checked, complete=complete, usage=usage)


def _claude_usage(response: Any) -> AiUsage:
    u = getattr(response, "usage", None)
    if u is None:
        return AiUsage(calls=1)

    def n(attr: str) -> int:
        v = getattr(u, attr, 0)
        return v if isinstance(v, int) else 0

    return AiUsage(
        calls=1,
        input_tokens=n("input_tokens")
        + n("cache_creation_input_tokens")
        + n("cache_read_input_tokens"),
        output_tokens=n("output_tokens"),
    )


# --------------------------------------------------------------------------------- Gemini


def _gemini_schema(schema: dict) -> dict:
    """Gemini's responseSchema is an OpenAPI subset without additionalProperties."""
    out = {k: v for k, v in schema.items() if k != "additionalProperties"}
    if "properties" in out:
        out["properties"] = {k: _gemini_schema(v) for k, v in out["properties"].items()}
    if "items" in out:
        out["items"] = _gemini_schema(out["items"])
    return out


class GeminiEngine(_EngineBase):
    name = "gemini"

    def __init__(self, settings: Settings, client: httpx.Client | None = None) -> None:
        self.settings = settings
        self.model = settings.gemini_model
        # httpx honors HTTPS_PROXY / SSL_CERT_FILE from the environment by default.
        self.client = client or httpx.Client(timeout=settings.ai_timeout_seconds)

    def _call(self, jpeg: bytes, mode: CallMode, system: str, text: str, schema: dict | None):
        s = self.settings
        url = f"{s.gemini_base_url.rstrip('/')}/v1beta/models/{self.model}:generateContent"
        gen: dict[str, Any] = {"temperature": 0, "maxOutputTokens": MAX_TOKENS[mode]}
        if schema is not None:
            gen["responseMimeType"] = "application/json"
            gen["responseSchema"] = _gemini_schema(schema)
        if s.ai_ocr_effort == "low" and "flash" in self.model:
            gen["thinkingConfig"] = {"thinkingBudget": 0}  # OCR needs no reasoning tokens
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [
                {
                    "parts": [
                        {
                            "inline_data": {
                                "mime_type": "image/jpeg",
                                "data": base64.standard_b64encode(jpeg).decode("ascii"),
                            }
                        },
                        {"text": text},
                    ]
                }
            ],
            "generationConfig": gen,
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
            cand = data["candidates"][0]
            parts = cand.get("content", {}).get("parts", [])
        except (ValueError, KeyError, IndexError) as exc:
            raise AiEngineError("پاسخ Gemini قابل خواندن نبود یا خالی بود.") from exc
        out = "".join(p.get("text", "") for p in parts if not p.get("thought"))
        finish = cand.get("finishReason")
        if not out.strip() and finish not in (None, "STOP"):
            raise AiEngineError(f"Gemini پاسخی نداد ({finish}).")
        meta = data.get("usageMetadata", {}) or {}
        usage = AiUsage(
            calls=1,
            input_tokens=int(meta.get("promptTokenCount", 0) or 0),
            output_tokens=int(meta.get("candidatesTokenCount", 0) or 0)
            + int(meta.get("thoughtsTokenCount", 0) or 0),
        )
        return out, finish != "MAX_TOKENS", usage

    def transcribe_ex(self, jpeg: bytes, mode: Mode = "page") -> AiResult:
        text, complete, usage = self._call(jpeg, mode, SYSTEM_OCR, user_prompt(mode), None)
        return AiResult(text=clean_output(text), complete=complete, usage=usage)

    def correct(self, jpeg: bytes, lines: list[str]) -> AiResult:
        text, complete, usage = self._call(
            jpeg, "correct", SYSTEM_CORRECT, correction_prompt(lines), CORRECTION_SCHEMA
        )
        corrections, checked = parse_corrections(text) if complete else ([], [])
        return AiResult(corrections=corrections, checked=checked, complete=complete, usage=usage)


# ------------------------------------------------------------------------------ factories


def claude_configured(settings: Settings) -> bool:
    # A base URL alone is not enough: ANTHROPIC_BASE_URL is often set by unrelated tooling.
    # For a relay that injects credentials itself, set any placeholder ANTHROPIC_API_KEY.
    return bool(settings.anthropic_api_key)


def gemini_configured(settings: Settings) -> bool:
    return bool(settings.gemini_api_key)


def get_ai_engine(name: str, settings: Settings) -> AiEngine | None:
    if name == "claude" and claude_configured(settings):
        return ClaudeEngine(settings)
    if name == "gemini" and gemini_configured(settings):
        return GeminiEngine(settings)
    return None


def engine_status(settings: Settings) -> dict[str, bool]:
    return {
        "offline": tesseract_available(settings, "fas"),
        "claude": claude_configured(settings),
        "gemini": gemini_configured(settings),
    }
