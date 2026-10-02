"""Turn uploaded files (PDFs and/or phone photos) into one PDF document.

Each image becomes one page, sized so that rendering at `dpi` reproduces the
photo's own pixels — no resampling before OCR. EXIF orientation (phones store
portrait shots sideways plus a rotation tag) is applied first.
"""

from __future__ import annotations

import io

import pymupdf
from PIL import Image, ImageOps, UnidentifiedImageError

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp"}

try:  # iPhone photos (HEIC)
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # pragma: no cover - optional dependency
    pass


class UploadError(ValueError):
    """Persian message for the admin."""


def is_pdf(data: bytes) -> bool:
    return data[:5] == b"%PDF-"


def _image_page(doc: pymupdf.Document, name: str, data: bytes, dpi: int) -> None:
    try:
        with Image.open(io.BytesIO(data)) as image:
            frames = []
            for index in range(getattr(image, "n_frames", 1)):  # multi-page TIFF
                image.seek(index)
                frames.append(ImageOps.exif_transpose(image.convert("RGB")))
    except (UnidentifiedImageError, OSError) as exc:
        raise UploadError(f"فایل «{name}» تصویر معتبری نیست.") from exc
    for frame in frames:
        buffer = io.BytesIO()
        frame.save(buffer, format="JPEG", quality=92)
        width, height = frame.size
        page = doc.new_page(width=width * 72 / dpi, height=height * 72 / dpi)
        page.insert_image(page.rect, stream=buffer.getvalue())


def combine(files: list[tuple[str, bytes]], dpi: int) -> tuple[bytes, int]:
    """Merge PDFs and images in the given order. Returns (pdf_bytes, page_count)."""
    if len(files) == 1 and is_pdf(files[0][1]):
        name, data = files[0]
        return data, _page_count(name, data)

    out = pymupdf.open()
    for name, data in files:
        if is_pdf(data):
            try:
                with pymupdf.open(stream=data, filetype="pdf") as src:
                    out.insert_pdf(src)
            except Exception as exc:
                raise UploadError(f"فایل «{name}» یک PDF معتبر نیست.") from exc
        else:
            _image_page(out, name, data, dpi)
    if out.page_count == 0:
        raise UploadError("هیچ صفحه‌ای در فایل‌های انتخاب‌شده پیدا نشد.")
    pages = out.page_count
    data = out.tobytes(garbage=3, deflate=True)
    out.close()
    return data, pages


def _page_count(name: str, data: bytes) -> int:
    try:
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            if doc.needs_pass:
                raise UploadError(f"فایل «{name}» رمز دارد؛ نسخه‌ی بدون رمز را بارگذاری کنید.")
            count = doc.page_count
    except UploadError:
        raise
    except Exception as exc:
        raise UploadError(f"فایل «{name}» یک PDF معتبر نیست.") from exc
    if count == 0:
        raise UploadError(f"فایل «{name}» هیچ صفحه‌ای ندارد.")
    return count
