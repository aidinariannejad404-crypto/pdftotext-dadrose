"""Image clean-up for mobile scans before OCR.

`preprocess(image_bgr)` returns a gray uint8 image ready for Tesseract / AI engines and the
list of steps that were actually applied (each step runs only when it is needed).
"""

from __future__ import annotations

import logging

import cv2
import numpy as np

log = logging.getLogger(__name__)

ANALYSIS_SIDE = 1000  # long side of the downscaled copy used for detection
# Tesseract (LSTM, fas) reads best when the median glyph-component height is ~40 px;
# measured on synthetic booklet scans: 26 px → 0.94 similarity, 40 px → 0.99.
TARGET_GLYPH_PX = 40.0
MAX_UPSCALE = 2.5
OSD_MIN_CONF = 1.5  # tesseract OSD orientation confidence needed to rotate

# Persian step names shown in the UI.
STEP_CROP = "برش و اصلاح پرسپکتیو"
STEP_ROTATE = "چرخش {deg}°"
STEP_DESKEW = "صاف کردن کجی ({deg:+.1f}°)"
STEP_SHADOW = "حذف سایه و نور ناهموار"
STEP_CONTRAST = "بهبود کنتراست"
STEP_DENOISE = "حذف نویز"
STEP_UPSCALE = "بزرگ‌نمایی ×{f:.1f}"


def _downscale(img: np.ndarray, side: int = ANALYSIS_SIDE) -> tuple[np.ndarray, float]:
    h, w = img.shape[:2]
    s = side / max(h, w)
    if s >= 1:
        return img, 1.0
    return cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA), s


# ------------------------------------------------------------------------ page detection


def _order_quad(pts: np.ndarray) -> np.ndarray:
    """Order 4 points as top-left, top-right, bottom-right, bottom-left."""
    pts = pts.reshape(4, 2).astype(np.float32)
    s = pts.sum(1)
    d = np.diff(pts, axis=1).ravel()
    return np.array(
        [pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], np.float32
    )


def find_document_quad(gray: np.ndarray) -> np.ndarray | None:
    """Find the paper sheet as a convex quadrilateral covering 25–97% of the image.
    Returns the 4 corners (ordered, in `gray` coordinates) or None."""
    small, s = _downscale(gray, 800)
    area = small.shape[0] * small.shape[1]
    blur = cv2.GaussianBlur(small, (5, 5), 0)
    candidates: list[np.ndarray] = []
    # (a) bright paper vs darker background
    _, th = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    th = cv2.morphologyEx(th, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    candidates.append(th)
    # (b) edges
    edges = cv2.Canny(blur, 40, 120)
    candidates.append(cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2))

    best: np.ndarray | None = None
    best_area = 0.0
    for mask in candidates:
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
            a = cv2.contourArea(c)
            if not (0.25 * area <= a <= 0.97 * area):
                continue
            hull = cv2.convexHull(c)
            peri = cv2.arcLength(hull, True)
            for eps in (0.01, 0.02, 0.03, 0.05):
                approx = cv2.approxPolyDP(hull, eps * peri, True)
                if len(approx) == 4:
                    break
            if len(approx) != 4 or not cv2.isContourConvex(approx):
                continue
            qa = cv2.contourArea(approx)
            # The quad must describe the blob well (rejects odd shapes / text blocks).
            if qa < 0.25 * area or qa > 0.97 * area or a / qa < 0.9:
                continue
            if qa > best_area:
                best, best_area = approx, qa
    if best is None:
        return None
    quad = _order_quad(best) / s
    # A quad hugging the image border means "already cropped" — leave it alone.
    h, w = gray.shape[:2]
    margin = 0.015 * max(h, w)
    near = (
        (quad[:, 0] < margin)
        | (quad[:, 0] > w - margin)
        | (quad[:, 1] < margin)
        | (quad[:, 1] > h - margin)
    )
    if near.all():
        return None
    return quad


def warp_quad(img: np.ndarray, quad: np.ndarray) -> np.ndarray:
    tl, tr, br, bl = quad
    w = int(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))
    h = int(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))
    dst = np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
    m = cv2.getPerspectiveTransform(quad.astype(np.float32), dst)
    out = cv2.warpPerspective(
        img, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE
    )
    # Trim a thin margin: the detected edge usually keeps a sliver of the dark background.
    t = max(2, int(0.006 * max(w, h)))
    return out[t : h - t, t : w - t]


# --------------------------------------------------------------------------- orientation


def _text_mask(gray: np.ndarray) -> np.ndarray:
    """Binary (text=255) mask of a downscaled gray image, robust to uneven lighting."""
    return cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 25, 15
    )


def _profile_score(mask: np.ndarray) -> float:
    rows = mask.sum(1, dtype=np.float64)
    return float(np.var(rows))


def detect_orientation(
    gray: np.ndarray, tesseract_cmd: str | None = None, tessdata_dir: str = ""
) -> int:
    """Clockwise rotation (0/90/180/270) that makes the text upright."""
    small, _ = _downscale(gray, 1600)
    try:
        import pytesseract

        if tesseract_cmd:
            pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
        from app.ocr.tesseract import tessdata_flag

        cfg = "--psm 0" + tessdata_flag(tessdata_dir)
        osd = pytesseract.image_to_osd(small, config=cfg, output_type=pytesseract.Output.DICT)
        if float(osd.get("orientation_conf", 0)) >= OSD_MIN_CONF:
            return int(osd.get("rotate", 0)) % 360
    except Exception as exc:  # noqa: BLE001 — OSD fails on pages with too little text
        log.debug("OSD failed: %s", exc)
    # Fallback: horizontal text lines give a much spikier row profile than columns do.
    mask = _text_mask(_downscale(gray, 800)[0])
    if _profile_score(mask.T) > 1.5 * _profile_score(mask):
        return 90  # cannot tell 90 from 270 without OSD; 90 is the common phone case
    return 0


def rotate_quadrant(img: np.ndarray, deg: int) -> np.ndarray:
    return {
        90: lambda: cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE),
        180: lambda: cv2.rotate(img, cv2.ROTATE_180),
        270: lambda: cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE),
    }.get(deg, lambda: img)()


# -------------------------------------------------------------------------------- deskew


def estimate_skew(gray: np.ndarray, max_angle: float = 8.0) -> float:
    """Skew angle in degrees (positive = rotate counter-clockwise to fix) found by
    maximizing the variance of the horizontal projection profile."""
    small, _ = _downscale(gray, ANALYSIS_SIDE)
    mask = _text_mask(small)
    # Ignore borders (page edges / desk remnants dominate the profile otherwise).
    h, w = mask.shape
    mask = mask[int(0.03 * h) : int(0.97 * h), int(0.03 * w) : int(0.97 * w)]
    h, w = mask.shape
    center = (w / 2, h / 2)

    def score(a: float) -> float:
        m = cv2.getRotationMatrix2D(center, a, 1.0)
        rot = cv2.warpAffine(mask, m, (w, h), flags=cv2.INTER_NEAREST)
        return _profile_score(rot)

    coarse = np.arange(-max_angle, max_angle + 1e-6, 0.5)
    best = max(coarse, key=score)
    fine = np.arange(best - 0.5, best + 0.5 + 1e-6, 0.1)
    return float(max(fine, key=score))


def rotate_by(gray: np.ndarray, angle: float) -> np.ndarray:
    h, w = gray.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    # Expand the canvas so corners aren't cut off.
    cos, sin = abs(m[0, 0]), abs(m[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    m[0, 2] += nw / 2 - w / 2
    m[1, 2] += nh / 2 - h / 2
    return cv2.warpAffine(gray, m, (nw, nh), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


# ---------------------------------------------------------------------------- photometry


def estimate_background(gray: np.ndarray) -> np.ndarray:
    """Paper-colour background: close (dilate) away dark text, then median-smooth.
    Computed on a downscaled copy for speed."""
    small, s = _downscale(gray, 900)
    k = max(7, round(min(small.shape) / 60) | 1)
    bg = cv2.dilate(small, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    bg = cv2.medianBlur(bg, 21)
    if s != 1.0:
        bg = cv2.resize(bg, (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_LINEAR)
    return bg


def remove_shadow(gray: np.ndarray) -> tuple[np.ndarray, bool]:
    bg = estimate_background(gray)
    lo, hi = np.percentile(bg, (5, 95))
    if hi - lo < 18:  # evenly lit already
        return gray, False
    norm = cv2.divide(gray, np.maximum(bg, 1), scale=255)
    return norm, True


def stretch_contrast(gray: np.ndarray) -> tuple[np.ndarray, bool]:
    """Percentile stretch: ink → near black, paper → white. Keeps gray levels."""
    lo, hi = np.percentile(gray, (0.5, 99.0))
    if hi - lo < 50:  # (near-)blank page: stretching would only amplify paper noise
        return gray, False
    if lo < 25 and hi > 235:
        return gray, False
    lut = np.clip((np.arange(256) - lo) * 255.0 / (hi - lo), 0, 255).astype(np.uint8)
    return cv2.LUT(gray, lut), True


def glyph_height(gray: np.ndarray) -> float | None:
    """Median height (px) of ink connected components — a proxy for the text size."""
    _, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    _, _, stats, _ = cv2.connectedComponentsWithStats(th, connectivity=8)
    hs = stats[1:, cv2.CC_STAT_HEIGHT]
    keep = (hs > 4) & (stats[1:, cv2.CC_STAT_AREA] > 15) & (hs < gray.shape[0] / 20)
    if keep.sum() < 30:
        return None
    return float(np.median(hs[keep]))


def upscale_factor(gray: np.ndarray) -> float:
    gh = glyph_height(gray)
    if gh is None:
        # Unknown text size: fall back to page width (phone photos of a page ≈ 1000–1500 px).
        return 2.0 if gray.shape[1] < 1600 else 1.0
    f = min(MAX_UPSCALE, TARGET_GLYPH_PX / gh)
    return f if f >= 1.25 else 1.0


def noise_level(gray: np.ndarray) -> float:
    small, _ = _downscale(gray, 800)
    return float(np.median(np.abs(small.astype(np.int16) - cv2.medianBlur(small, 3))))


# ---------------------------------------------------------------------------------- main


def preprocess(
    image_bgr: np.ndarray, tesseract_cmd: str | None = None, tessdata_dir: str = ""
) -> tuple[np.ndarray, list[str]]:
    steps: list[str] = []
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY) if image_bgr.ndim == 3 else image_bgr

    quad = find_document_quad(gray)
    if quad is not None:
        gray = warp_quad(gray, quad)
        steps.append(STEP_CROP)

    rot = detect_orientation(gray, tesseract_cmd, tessdata_dir)
    if rot:
        gray = rotate_quadrant(gray, rot)
        steps.append(STEP_ROTATE.format(deg=rot))

    angle = estimate_skew(gray)
    if abs(angle) >= 0.2:
        gray = rotate_by(gray, angle)
        steps.append(STEP_DESKEW.format(deg=angle))

    gray, done = remove_shadow(gray)
    if done:
        steps.append(STEP_SHADOW)

    gray, done = stretch_contrast(gray)
    if done:
        steps.append(STEP_CONTRAST)

    if noise_level(gray) > 2.0:
        gray = cv2.medianBlur(gray, 3)
        steps.append(STEP_DENOISE)

    f = upscale_factor(gray)
    if f > 1.0:
        gray = cv2.resize(gray, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
        steps.append(STEP_UPSCALE.format(f=f))
    return gray, steps
