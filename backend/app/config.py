from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All runtime configuration comes from environment variables (or `.env`)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    data_dir: Path = Path("data")
    # HTTP Basic auth for the whole UI/API (user name is ignored). Empty = no auth.
    admin_password: str = ""
    # Number of documents processed in parallel.
    workers: int = 2
    # Pages processed in parallel inside a document; 0 = automatic (CPU cores / workers).
    page_workers: int = 0

    # ---- rendering / offline OCR
    render_dpi: int = 300
    tesseract_lang: str = "fas"  # fas+eng measured worse: Persian words misread as Latin
    tesseract_cmd: str = "tesseract"
    # Directory with tessdata_best models (much more accurate for Persian). Empty = system default.
    tessdata_dir: str = ""

    # ---- AI engines. Outbound calls honor HTTPS_PROXY; a relay can be used via base URLs.
    anthropic_api_key: str = ""
    anthropic_base_url: str = ""
    claude_model: str = "claude-opus-5-5"
    claude_effort: str = "medium"  # low | medium | high | xhigh | max
    gemini_api_key: str = ""
    gemini_base_url: str = "https://generativelanguage.googleapis.com"
    gemini_model: str = "gemini-2.5-flash"
    # Engine used when a project asks for "auto": claude | gemini (falls back to offline).
    default_ai_engine: str = "claude"
    ai_timeout_seconds: float = 180.0

    # ---- AI token economy. Engine "auto" = smart: offline first, AI only where it fails.
    # Pages whose offline quality score (0..1) is below this get a full AI transcription;
    # better pages only send their suspicious lines for correction.
    page_ai_threshold: float = 0.6
    # Effort for OCR / correction / classification calls (thinking tokens are billed).
    ai_ocr_effort: str = "low"
    # Hard cap of AI calls per project; beyond it the project continues offline.
    ai_max_calls_per_project: int = 150
    # Re-use earlier AI answers for identical inputs (reprocessing, duplicate pages).
    ai_cache: bool = True
    # Price estimates (USD per million tokens) for the cost shown in the UI.
    claude_price_in: float = 4.0
    claude_price_out: float = 20.0
    gemini_price_in: float = 0.3
    gemini_price_out: float = 2.5

    # ---- DADROSE site integration
    dadrose_api_url: str = ""  # e.g. https://api.dadrose.com
    dadrose_api_token: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
