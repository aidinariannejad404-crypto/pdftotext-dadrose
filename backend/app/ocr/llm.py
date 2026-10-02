"""AI transcription engines (Claude, Gemini) for Persian exam pages.

Both engines receive a JPEG of the (preprocessed) page or of a cropped question region and
return plain text. Network errors are re-raised as `AiEngineError` with a Persian message.
"""

from __future__ import annotations

import base64
import logging
import re
from typing import Literal, Protocol

import anthropic
import httpx

from app.config import Settings
from app.ocr.tesseract import tesseract_available

log = logging.getLogger(__name__)

Mode = Literal["page", "region"]

_RULES = """\
قواعد:
- متن را دقیقاً همان‌طور که چاپ شده بنویس؛ هیچ اصلاح، خلاصه، ترجمه یا افزودنی نکن.
- شکست سطرها و ترتیب خواندن را حفظ کن: راست‌به‌چپ، از بالا به پایین؛ اگر صفحه دو ستونی است \
اول ستون راست کامل، بعد ستون چپ.
- شماره‌ی سؤال‌ها و نشانه‌ی گزینه‌ها را دقیقاً همان‌طور که چاپ شده نگه دار (مثلاً «۱۲-»، «۱)»، «الف)»).
- از «ی» و «ک» فارسی استفاده کن (نه ي و ك عربی). نیم‌فاصله‌ها را در صورت وجود حفظ کن.
- جدول‌ها (مثل جدول کلید پاسخ‌ها): هر ردیف در یک سطر، خانه‌ها با « | » جدا شوند.
- بخش ناخوانا را با [؟] مشخص کن؛ حدس نزن.
- واترمارک برنامه‌های اسکن (مثل CamScanner)، سربرگ/پاورقی تزئینی و شماره‌ی صفحه را نادیده بگیر.
- فقط متن رونویسی‌شده را خروجی بده: بدون توضیح، بدون مقدمه، بدون علامت‌گذاری markdown یا ```.

Precise OCR task: transcribe exactly, preserve line breaks and RTL reading order, output only \
the transcription."""

PAGE_PROMPT = (
    "این تصویر یک صفحه از دفترچه‌ی آزمون حقوقی (وکالت) یا پاسخ تشریحی آن به زبان فارسی است. "
    "کل متن صفحه را با دقت کامل رونویسی کن (OCR دقیق).\n\n" + _RULES
)
REGION_PROMPT = (
    "این تصویر بخشی بریده‌شده از یک صفحه‌ی دفترچه‌ی آزمون حقوقی فارسی است و معمولاً شامل یک سؤال "
    "(صورت سؤال و گزینه‌ها) یا پاسخ تشریحی آن است. متن این بخش را با دقت کامل رونویسی کن؛ "
    "سطرهای نیمه‌بریده در لبه‌های تصویر را فقط اگر خوانا هستند بنویس.\n\n" + _RULES
)

_FENCE_RE = re.compile(r"^\s*```[a-zA-Z]*\s*\n?|\n?\s*```\s*$")


class AiEngineError(RuntimeError):
    """An AI engine call failed; `str(err)` is a Persian message fit for the UI."""


class AiEngine(Protocol):
    name: str

    def transcribe(self, jpeg: bytes, mode: Mode = "page") -> str: ...


def prompt_for(mode: Mode) -> str:
    return REGION_PROMPT if mode == "region" else PAGE_PROMPT


def clean_output(text: str) -> str:
    """Strip accidental markdown fences and surrounding whitespace."""
    text = text.strip()
    if text.startswith("```") or text.endswith("```"):
        text = _FENCE_RE.sub("", text).strip()
    return text


# --------------------------------------------------------------------------------- Claude


class ClaudeEngine:
    name = "claude"

    def __init__(self, settings: Settings, client: anthropic.Anthropic | None = None) -> None:
        self.settings = settings
        self.client = client or anthropic.Anthropic(
            api_key=settings.anthropic_api_key or None,
            base_url=settings.anthropic_base_url or None,
            timeout=settings.ai_timeout_seconds,
            max_retries=3,
        )
        self._use_beta = True

    def _create(self, content: list[dict]):
        s = self.settings
        common = {
            "model": s.claude_model,
            "max_tokens": 16000,
            "output_config": {"effort": s.claude_effort},
            "messages": [{"role": "user", "content": content}],
        }
        if self._use_beta:
            try:
                return self.client.beta.messages.create(
                    **common, betas=["server-side-fallback-2026-07-01"], fallbacks="default"
                )
            except anthropic.BadRequestError as exc:
                msg = str(exc).lower()
                if "fallback" not in msg and "beta" not in msg:
                    raise
                # A relay that doesn't know the beta: retry once without it, and remember.
                log.warning("Claude relay rejected fallbacks beta; retrying without it")
                self._use_beta = False
        return self.client.messages.create(**common)

    def transcribe(self, jpeg: bytes, mode: Mode = "page") -> str:
        b64 = base64.standard_b64encode(jpeg).decode("ascii")
        content = [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
            {"type": "text", "text": prompt_for(mode)},
        ]
        try:
            response = self._create(content)
        except anthropic.RateLimitError as exc:
            raise AiEngineError("محدودیت تعداد درخواست Claude؛ کمی بعد دوباره تلاش کنید.") from exc
        except anthropic.APIStatusError as exc:
            if exc.status_code in (401, 403):
                raise AiEngineError("کلید API برای Claude نامعتبر است یا دسترسی ندارد.") from exc
            raise AiEngineError(f"خطای سرویس Claude (کد {exc.status_code}).") from exc
        except anthropic.APIConnectionError as exc:
            raise AiEngineError("اتصال به سرویس Claude برقرار نشد (شبکه/پراکسی را بررسی کنید).") from exc

        if response.stop_reason == "refusal":
            raise AiEngineError("Claude از رونویسی این تصویر خودداری کرد.")
        text = "".join(b.text for b in response.content if getattr(b, "type", None) == "text")
        if response.stop_reason == "max_tokens":
            log.warning("Claude transcription hit max_tokens; output is truncated")
            if not text.strip():
                raise AiEngineError("پاسخ Claude ناقص ماند (سقف طول خروجی).")
        return clean_output(text)


# --------------------------------------------------------------------------------- Gemini


class GeminiEngine:
    name = "gemini"

    def __init__(self, settings: Settings, client: httpx.Client | None = None) -> None:
        self.settings = settings
        # httpx honors HTTPS_PROXY / SSL_CERT_FILE from the environment by default.
        self.client = client or httpx.Client(timeout=settings.ai_timeout_seconds)

    def transcribe(self, jpeg: bytes, mode: Mode = "page") -> str:
        s = self.settings
        url = f"{s.gemini_base_url.rstrip('/')}/v1beta/models/{s.gemini_model}:generateContent"
        body = {
            "contents": [
                {
                    "parts": [
                        {
                            "inline_data": {
                                "mime_type": "image/jpeg",
                                "data": base64.standard_b64encode(jpeg).decode("ascii"),
                            }
                        },
                        {"text": prompt_for(mode)},
                    ]
                }
            ],
            "generationConfig": {"temperature": 0},
        }
        try:
            r = self.client.post(url, json=body, headers={"x-goog-api-key": s.gemini_api_key})
        except httpx.HTTPError as exc:
            raise AiEngineError("اتصال به سرویس Gemini برقرار نشد (شبکه/پراکسی را بررسی کنید).") from exc
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
        text = "".join(p.get("text", "") for p in parts)
        if not text.strip() and cand.get("finishReason") not in (None, "STOP"):
            raise AiEngineError(f"Gemini پاسخی نداد ({cand.get('finishReason')}).")
        return clean_output(text)


# ------------------------------------------------------------------------------ factories


def claude_configured(settings: Settings) -> bool:
    # A relay (base URL) may inject credentials itself.
    return bool(settings.anthropic_api_key or settings.anthropic_base_url)


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
