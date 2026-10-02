"""Synthetic test inputs: a Persian exam booklet page and "phone scan" variants of it.

Run directly to write the fixtures into a directory for manual inspection:
    uv run python -m tests.fixtures_gen /tmp/fixtures
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
import pymupdf

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

QUESTIONS: list[tuple[str, list[str]]] = [
    (
        "۱- در صورتی که مستأجر بدون اجازه مالک ملک را به دیگری اجاره دهد حکم قرارداد چیست؟",
        ["صحیح است", "باطل است", "غیر نافذ است", "قابل فسخ است"],
    ),
    (
        "۲- کدام یک از موارد زیر از شرایط اساسی صحت معامله نیست؟",
        ["قصد طرفین و رضای آنها", "اهلیت طرفین", "مشروعیت جهت معامله", "ثبت رسمی قرارداد"],
    ),
    (
        "۳- مهلت تجدید نظر خواهی از احکام دادگاه برای اشخاص مقیم ایران چند روز است؟",
        ["ده روز", "بیست روز", "یک ماه", "دو ماه"],
    ),
    (
        "۴- در جرائم قابل گذشت شکایت شاکی تا چه مدتی پس از اطلاع از وقوع جرم پذیرفته می‌شود؟",
        ["سه ماه", "شش ماه", "یک سال", "دو سال"],
    ),
]

# Ground-truth lines in reading order (each option on its own line).
GROUND_TRUTH_LINES: list[str] = []
for _stem, _opts in QUESTIONS:
    GROUND_TRUTH_LINES.append(_stem)
    for _i, _o in enumerate(_opts, 1):
        GROUND_TRUTH_LINES.append(f"{'۰۱۲۳۴۵۶۷۸۹'[_i]}) {_o}")
GROUND_TRUTH = "\n".join(GROUND_TRUTH_LINES)

_CSS = f"""
@font-face {{ font-family: fa; src: url({FONT}); }}
body {{ font-family: fa; font-size: 14px; }}
p {{ margin: 0 0 6px 0; }}
p.q {{ margin-top: 14px; font-weight: normal; }}
"""


def booklet_pdf() -> bytes:
    """A typed (text-layer) A4 page with 4 four-option questions."""
    html = "".join(f"<p dir=\"rtl\">{line}</p>" for line in GROUND_TRUTH_LINES)
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_htmlbox(pymupdf.Rect(50, 60, 545, 800), f"<div dir=\"rtl\">{html}</div>", css=_CSS)
    return doc.tobytes()


def render(pdf_bytes: bytes, dpi: int = 200) -> np.ndarray:
    with pymupdf.open(stream=pdf_bytes, filetype="pdf") as doc:
        pix = doc[0].get_pixmap(dpi=dpi)
        img = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
        return cv2.cvtColor(img[:, :, :3], cv2.COLOR_RGB2BGR)


def phone_scan(page_bgr: np.ndarray, angle: float = 4.0, seed: int = 0) -> np.ndarray:
    """Simulate a phone photo of the printed page: tilt, perspective, dark desk, shadow,
    sensor noise, slight blur and JPEG compression."""
    rng = np.random.default_rng(seed)
    h, w = page_bgr.shape[:2]
    # Paper is slightly off-white.
    paper = cv2.addWeighted(page_bgr, 0.9, np.full_like(page_bgr, 235), 0.1, 0)
    # Canvas (desk) bigger than the page.
    cw, ch = int(w * 1.35), int(h * 1.3)
    desk = np.zeros((ch, cw, 3), np.uint8)
    desk[:] = (60, 70, 85)
    desk = cv2.add(desk, rng.integers(0, 20, desk.shape, dtype=np.uint8))
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    ox, oy = (cw - w) / 2, (ch - h) / 2
    # Keystone: top edge narrower than bottom (camera tilted).
    dst = np.float32(
        [
            [ox + 0.06 * w, oy + 0.03 * h],
            [ox + 0.92 * w, oy + 0.01 * h],
            [ox + 1.02 * w, oy + 0.98 * h],
            [ox - 0.03 * w, oy + 1.0 * h],
        ]
    )
    m_rot = cv2.getRotationMatrix2D((cw / 2, ch / 2), angle, 1.0)
    dst = cv2.transform(dst[None], m_rot)[0].astype(np.float32)
    m = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(paper, m, (cw, ch))
    mask = cv2.warpPerspective(np.full((h, w), 255, np.uint8), m, (cw, ch))
    out = np.where(mask[..., None] > 0, warped, desk)
    # Shadow: diagonal illumination gradient (dark lower-left corner) + soft blob.
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    grad = 1.0 - 0.45 * ((cw - xx) / cw) * (yy / ch)
    blob = np.exp(-(((xx - 0.75 * cw) / (0.25 * cw)) ** 2 + ((yy - 0.3 * ch) / (0.2 * ch)) ** 2))
    illum = np.clip(grad - 0.2 * blob, 0.35, 1.0)
    out = (out.astype(np.float32) * illum[..., None]).clip(0, 255)
    # Lower contrast, add noise, slight defocus.
    out = out * 0.85 + 20
    out += rng.normal(0, 6, out.shape)
    out = cv2.GaussianBlur(out.clip(0, 255).astype(np.uint8), (3, 3), 0.8)
    ok, enc = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 60])
    assert ok
    return cv2.imdecode(enc, cv2.IMREAD_COLOR)


def clean_scan(page_bgr: np.ndarray) -> np.ndarray:
    """A flatbed-like scan: no geometry change, mild noise + JPEG."""
    rng = np.random.default_rng(1)
    out = page_bgr.astype(np.float32) + rng.normal(0, 3, page_bgr.shape)
    ok, enc = cv2.imencode(".jpg", out.clip(0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 80])
    assert ok
    return cv2.imdecode(enc, cv2.IMREAD_COLOR)


def image_pdf(images: list[np.ndarray], invisible_text: str | None = None) -> bytes:
    """Image-only PDF (one full-page JPEG per page), like a CamScanner export.
    `invisible_text` simulates the weak embedded OCR layer such apps add."""
    doc = pymupdf.open()
    for img in images:
        h, w = img.shape[:2]
        page = doc.new_page(width=w * 72 / 200, height=h * 72 / 200)
        ok, enc = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        assert ok
        page.insert_image(page.rect, stream=enc.tobytes())
        if invisible_text:
            page.insert_text((20, 40), invisible_text, render_mode=3, fontsize=10)
    return doc.tobytes()


def write_all(out: Path) -> dict[str, Path]:
    out.mkdir(parents=True, exist_ok=True)
    typed = booklet_pdf()
    page = render(typed, 200)
    variants = {
        "typed.pdf": typed,
        "clean_scan.pdf": image_pdf([clean_scan(page)]),
        "phone_scan.pdf": image_pdf([phone_scan(page)]),
        "phone_scan_rot90.pdf": image_pdf(
            [cv2.rotate(phone_scan(page, angle=-3, seed=2), cv2.ROTATE_90_CLOCKWISE)]
        ),
    }
    paths = {}
    for name, data in variants.items():
        p = out / name
        p.write_bytes(data)
        paths[name] = p
    cv2.imwrite(str(out / "phone_scan.jpg"), phone_scan(page))
    return paths


if __name__ == "__main__":
    print(write_all(Path(sys.argv[1] if len(sys.argv) > 1 else "fixtures")))
