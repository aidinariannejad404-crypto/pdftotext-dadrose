"""Send an exported DOCX straight into the DADROSE site's Word smart-import.

The site (dadrose-quiz, `adminapi.views.imports`) accepts the official template
at `POST /api/v1/admin/imports` (multipart `file`) and then runs its own
review / duplicate detection; the admin commits it in the site panel. This
client authenticates with a service token (`DADROSE_API_TOKEN`) that the site
maps to a dedicated import-only service account.
"""

from __future__ import annotations

import httpx

from .config import Settings


class SiteImportError(RuntimeError):
    """Persian message for the admin."""


def _client(settings: Settings) -> httpx.Client:
    if not (settings.dadrose_api_url and settings.dadrose_api_token):
        raise SiteImportError(
            "اتصال به سایت پیکربندی نشده است (DADROSE_API_URL و DADROSE_API_TOKEN)."
        )
    return httpx.Client(
        base_url=settings.dadrose_api_url.rstrip("/"),
        headers={"Authorization": f"Bearer {settings.dadrose_api_token}"},
        timeout=60,
    )


def _detail(response: httpx.Response) -> str:
    try:
        return str(response.json().get("detail") or response.text[:300])
    except ValueError:
        return response.text[:300]


def upload_docx(data: bytes, filename: str, settings: Settings) -> dict:
    """Create an import job on the site. Returns the site's ImportJob JSON."""
    try:
        with _client(settings) as client:
            response = client.post(
                "/api/v1/admin/imports",
                files={
                    "file": (
                        filename,
                        data,
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    )
                },
            )
    except httpx.HTTPError as exc:
        raise SiteImportError(f"ارتباط با سایت برقرار نشد: {exc}") from exc
    if response.status_code in (401, 403):
        raise SiteImportError(
            "سایت توکن اتصال را نپذیرفت (۴۰۱/۴۰۳). توکن و دسترسی حساب سرویس را بررسی کنید."
        )
    if response.status_code == 429:
        raise SiteImportError(f"سایت فعلاً درخواست جدید نمی‌پذیرد: {_detail(response)}")
    if response.status_code >= 400:
        raise SiteImportError(f"سایت فایل را نپذیرفت ({response.status_code}): {_detail(response)}")
    return response.json()


def job_status(job_id: int, settings: Settings) -> dict:
    try:
        with _client(settings) as client:
            response = client.get(f"/api/v1/admin/imports/{job_id}")
    except httpx.HTTPError as exc:
        raise SiteImportError(f"ارتباط با سایت برقرار نشد: {exc}") from exc
    if response.status_code >= 400:
        raise SiteImportError(
            f"وضعیت ورود از سایت دریافت نشد ({response.status_code}): {_detail(response)}"
        )
    return response.json()


def check_connection(settings: Settings) -> dict:
    """Cheap authenticated call used by the UI's «تست اتصال»."""
    try:
        with _client(settings) as client:
            response = client.get("/api/v1/admin/imports", params={"page_size": 1})
    except httpx.HTTPError as exc:
        raise SiteImportError(f"ارتباط با سایت برقرار نشد: {exc}") from exc
    if response.status_code >= 400:
        raise SiteImportError(f"اتصال ناموفق بود ({response.status_code}): {_detail(response)}")
    return {"ok": True}
