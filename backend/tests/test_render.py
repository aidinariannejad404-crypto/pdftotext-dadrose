"""Regression: phone-scanner PDFs must not be rendered far above the scan's resolution."""

from __future__ import annotations

import io

import numpy as np
import pymupdf
from PIL import Image

from app.pdf_input import MAX_RENDER_PIXELS, effective_dpi, render_page


def _image_pdf(px_w: int, px_h: int, page_w: float, page_h: float) -> pymupdf.Document:
    buffer = io.BytesIO()
    Image.fromarray(np.full((px_h, px_w, 3), 255, np.uint8)).save(buffer, format="JPEG")
    doc = pymupdf.open()
    page = doc.new_page(width=page_w, height=page_h)
    page.insert_image(page.rect, stream=buffer.getvalue())
    return doc


def test_ios_pixels_as_points_page_renders_at_native_size():
    # iOS "Scan Documents": page size in points == photo size in pixels
    doc = _image_pdf(1892, 2822, 1893.8, 2823.7)
    page = doc[0]
    assert effective_dpi(page, 300) < 80
    image = render_page(page, 300)
    assert abs(image.shape[1] - 1892) <= 4 and abs(image.shape[0] - 2822) <= 4


def test_normal_a4_scan_keeps_requested_dpi():
    doc = _image_pdf(2480, 3508, 595, 842)  # 300-dpi A4 scan
    assert round(effective_dpi(doc[0], 300)) == 300


def test_pixel_cap_for_huge_vector_pages():
    doc = pymupdf.open()
    page = doc.new_page(width=3000, height=4000)  # no image: only the pixel cap applies
    zoom = effective_dpi(page, 300) / 72
    assert 3000 * zoom * 4000 * zoom <= MAX_RENDER_PIXELS * 1.01
