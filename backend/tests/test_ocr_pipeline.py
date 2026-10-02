"""Tests for the OCR pipeline: PDF input, preprocessing, Tesseract, consensus, AI engines."""

from __future__ import annotations

import json
from difflib import SequenceMatcher
from pathlib import Path
from types import SimpleNamespace

import anthropic
import cv2
import httpx
import numpy as np
import pymupdf
import pytest

from app import pipeline
from app.config import Settings
from app.models import Line, Word
from app.ocr import consensus, llm
from app.ocr.consensus import comparable
from app.ocr.tesseract import _to_lines, ocr_tesseract, tesseract_available
from app.pdf_input import (
    fix_reversed,
    is_garbage,
    is_reversed_persian,
    render_document,
)
from app.preprocess import estimate_skew, preprocess
from tests import fixtures_gen as fg

BEST = Path("/opt/tessdata_best")
HAVE_BEST = (BEST / "fas.traineddata").is_file()
TESS = Settings(tessdata_dir=str(BEST) if HAVE_BEST else "", tesseract_lang="fas")

needs_tesseract = pytest.mark.skipif(not tesseract_available(TESS), reason="tesseract+fas missing")


def similarity(text: str, truth: str = fg.GROUND_TRUTH) -> float:
    """Character-level similarity on the comparison-normalized token stream."""
    a = " ".join(t for t in (comparable(x) for x in text.split()) if t)
    b = " ".join(t for t in (comparable(x) for x in truth.split()) if t)
    return SequenceMatcher(None, a, b, autojunk=False).ratio()


def lines_text(lines: list[Line]) -> str:
    return "\n".join(ln.text for ln in lines)


@pytest.fixture(scope="module")
def page_img() -> np.ndarray:
    return fg.render(fg.booklet_pdf(), 200)


@pytest.fixture(scope="module")
def variants(page_img: np.ndarray) -> dict[str, np.ndarray]:
    """Variants rendered back from their image-only PDFs at 300 dpi, as the app does."""
    pdfs = {
        "clean": fg.image_pdf([fg.clean_scan(page_img)]),
        "phone": fg.image_pdf([fg.phone_scan(page_img)]),
        "phone_hard": fg.image_pdf([fg.hard_phone_scan(page_img)]),
        "phone_rot90": fg.image_pdf(
            [cv2.rotate(fg.phone_scan(page_img, angle=-3, seed=2), cv2.ROTATE_90_CLOCKWISE)]
        ),
    }
    return {k: next(render_document(v, 300)).image_bgr for k, v in pdfs.items()}


# ------------------------------------------------------------------------------ pdf_input


def test_text_layer_typed_pdf_reading_order() -> None:
    (page,) = list(render_document(fg.booklet_pdf(), 100))
    assert page.text_lines is not None and page.text_words is not None
    assert len(page.text_words) == sum(len(ln.words) for ln in page.text_lines)
    texts = [ln.text for ln in page.text_lines]
    assert texts[0].startswith("۱- در صورتی که مستأجر")
    # Mirrored brackets fixed, presentation forms folded by NFKC.
    assert "۱) صحیح است" in texts
    assert "۴) دو سال" == texts[-1]
    assert all("\ufe8e" not in t and "\ufbfd" not in t for t in texts)
    assert similarity("\n".join(texts)) > 0.99
    # Bboxes normalized; RTL words go right-to-left.
    first = page.text_lines[0].words
    assert all(0 <= v <= 1 for w in first for v in w.bbox)
    assert first[0].bbox[0] > first[1].bbox[0] > first[2].bbox[0]


def test_scanned_pdf_with_invisible_ocr_layer_is_not_trusted(page_img: np.ndarray) -> None:
    pdf = fg.image_pdf(
        [fg.clean_scan(page_img)], invisible_text="Scanned with CamScanner ca ae bad layer text"
    )
    (page,) = list(render_document(pdf, 72))
    assert page.text_words is None and page.text_lines is None
    assert page.text_layer_note == "scanned_image"


def test_image_only_pdf_has_no_text_layer(page_img: np.ndarray) -> None:
    (page,) = list(render_document(fg.image_pdf([page_img]), 72))
    assert page.text_words is None
    assert page.image_bgr.ndim == 3


def test_garbage_detection() -> None:
    assert is_garbage("\ue001\ue002\ue003 \ue004\ue005 abc")
    assert is_garbage("ÇáÚÑÈíÉ ÇáÓÚæÏíÉ ÝÞå ÇáÞÇäæä")  # cp1256 read as latin-1
    assert is_garbage("\ufffd\ufffd\ufffd متن")
    assert not is_garbage("در صورتی که مستأجر بدون اجازه مالک")
    assert not is_garbage("Civil Procedure Code, Article 12")
    assert not is_garbage("Le Café à Paris est très célèbre")  # some accents are fine


def test_reversed_detection_unit() -> None:
    logical = "حکم این قرارداد از نظر قانون به نفع کسی که در این مورد را با او".split()
    visual = [w[::-1] for w in logical]
    assert not is_reversed_persian(logical)
    assert is_reversed_persian(visual)
    assert fix_reversed("زا") == "از"
    assert fix_reversed("123") == "123"


def test_reversed_text_layer_is_repaired() -> None:
    """A PDF whose Persian is stored in visual order (no shaping, chars left-to-right)."""
    logical = "در این مورد حکم به نفع کسی است که از او را با ما"
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_font(fontname="dv", fontfile=fg.FONT)
    page.insert_text((50, 100), logical[::-1], fontname="dv", fontsize=12)
    page.insert_text((50, 130), "قانون مدنی در این باره به ما که از را با"[::-1], fontname="dv")
    (rp,) = list(render_document(doc.tobytes(), 72))
    assert rp.text_lines is not None
    assert rp.text_lines[0].text == logical


# ----------------------------------------------------------------------------- preprocess


def test_preprocess_deskews_flatbed_scan(page_img: np.ndarray) -> None:
    h, w = page_img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), 3.0, 1.0)
    skewed = cv2.warpAffine(page_img, m, (w, h), borderValue=(255, 255, 255))
    gray = cv2.cvtColor(skewed, cv2.COLOR_BGR2GRAY)
    assert abs(estimate_skew(gray) + 3.0) < 0.3
    out, steps = preprocess(skewed)
    assert any("کجی" in s for s in steps)
    assert not any("برش" in s for s in steps)  # white border: nothing to crop
    assert abs(estimate_skew(out)) < 0.3


def test_preprocess_removes_perspective_and_shadow(variants: dict[str, np.ndarray]) -> None:
    out, steps = preprocess(variants["phone_hard"])
    assert any("پرسپکتیو" in s for s in steps)
    assert any("سایه" in s for s in steps)
    h, w = out.shape
    assert abs(h / w - 842 / 595) < 0.08  # back to A4 proportions
    assert abs(estimate_skew(out)) < 0.5
    # Illumination flattened: paper brightness similar in all four quadrants.
    q = [out[: h // 2, : w // 2], out[: h // 2, w // 2 :], out[h // 2 :, : w // 2], out[h // 2 :, w // 2 :]]
    paper = [np.percentile(x, 90) for x in q]
    assert max(paper) - min(paper) < 20


@needs_tesseract
def test_preprocess_fixes_90_degree_rotation(variants: dict[str, np.ndarray]) -> None:
    out, steps = preprocess(variants["phone_rot90"], tessdata_dir=TESS.tessdata_dir)
    assert any("چرخش" in s for s in steps)
    assert out.shape[0] > out.shape[1]


def test_preprocess_leaves_cropped_scan_uncropped(variants: dict[str, np.ndarray]) -> None:
    _, steps = preprocess(variants["clean"])
    assert not any("برش" in s for s in steps)
    assert not any("کجی" in s for s in steps)


def test_preprocess_speed(variants: dict[str, np.ndarray]) -> None:
    import time

    t = time.perf_counter()
    preprocess(variants["phone"])
    assert time.perf_counter() - t < 4.0  # ~1 s on a laptop core; generous for CI


# ------------------------------------------------------------------------------ tesseract

# Measured with tessdata_best + lang=fas (see report): clean 0.985, phone 0.991,
# hard 0.998, rot90 0.984. Default (fast) fas data: 0.92–0.97.
THRESH = 0.95 if HAVE_BEST else 0.90


@needs_tesseract
@pytest.mark.parametrize("name", ["clean", "phone", "phone_hard", "phone_rot90"])
def test_tesseract_accuracy_after_preprocess(variants: dict[str, np.ndarray], name: str) -> None:
    gray, _ = preprocess(variants[name], tessdata_dir=TESS.tessdata_dir)
    lines = ocr_tesseract(gray, 0, TESS)
    sim = similarity(lines_text(lines))
    print(f"{name}: {sim:.3f}")
    assert sim >= THRESH
    for ln in lines:
        assert ln.page == 0 and ln.bbox is not None
        for w in ln.words:
            assert w.conf is not None and 0 <= w.conf <= 100
            assert (w.flag == "low_conf") == (w.conf < 60)


@needs_tesseract
def test_preprocessing_helps_on_hard_phone_scan(variants: dict[str, np.ndarray]) -> None:
    raw = cv2.cvtColor(variants["phone_hard"], cv2.COLOR_BGR2GRAY)
    raw_sim = similarity(lines_text(ocr_tesseract(raw, 0, TESS)))
    gray, _ = preprocess(variants["phone_hard"], tessdata_dir=TESS.tessdata_dir)
    pre_sim = similarity(lines_text(ocr_tesseract(gray, 0, TESS)))
    print(f"hard phone scan: raw {raw_sim:.3f} → preprocessed {pre_sim:.3f}")
    assert pre_sim > raw_sim + 0.15


def test_tesseract_lines_drop_watermarks_and_empty_words() -> None:
    def row(block, line, word, text, left, conf=90):
        return dict(
            block_num=block, par_num=1, line_num=line, text=text, conf=conf,
            left=left, top=10 * line, width=40, height=20,
        )  # fmt: skip

    rows = [
        row(1, 1, 1, "۱-", 900),
        row(1, 1, 2, "سؤال", 800, conf=40),
        row(1, 1, 3, "  ", 700),
        row(1, 2, 1, "Scanned", 100),
        row(1, 2, 2, "with", 150),
        row(1, 2, 3, "CamScanner", 200),
        row(1, 3, 1, "\u200fاول", 900, conf=-1),
    ]
    data = {k: [r[k] for r in rows] for k in rows[0]}
    lines = _to_lines(data, 1000, 1000, page=2)
    assert len(lines) == 1
    assert [w.text for w in lines[0].words] == ["۱-", "سؤال"]
    assert lines[0].words[1].flag == "low_conf"
    assert lines[0].page == 2
    assert lines[0].bbox == (0.8, 0.01, 0.94, 0.03)


# ------------------------------------------------------------------------------ consensus


def _tess_line(words: list[tuple[str, float]], y: float, page: int = 0) -> Line:
    """Fabricate a Tesseract RTL line: words laid out right to left."""
    out = []
    x = 0.95
    for text, conf in words:
        w = 0.02 * max(1, len(text))
        out.append(Word(text=text, bbox=(x - w, y, x, y + 0.02), conf=conf))
        x -= w + 0.01
    return Line(page=page, words=out, bbox=(x, y, 0.95, y + 0.02))


def test_merge_agreement_is_trusted_even_with_low_conf() -> None:
    tess = [_tess_line([("۱-", 95), ("حکم", 40), ("قرارداد", 90), ("چیست؟", 88)], 0.1)]
    lines, warnings = consensus.merge("۱- حکم قرارداد چیست؟", tess, 0)
    assert warnings == []
    assert len(lines) == 1
    ws = lines[0].words
    assert [w.text for w in ws] == ["۱-", "حکم", "قرارداد", "چیست؟"]
    assert all(w.flag is None for w in ws)
    assert ws[1].bbox == tess[0].words[1].bbox and ws[1].conf == 40
    assert lines[0].bbox is not None


def test_merge_normalization_counts_as_agreement() -> None:
    # Arabic yeh/kaf, digits, ZWNJ vs none, punctuation differences are not disagreements.
    tess = [_tess_line([("1-", 90), ("مي‌شود", 90), ("كتاب", 90), ("(۲", 90)], 0.1)]
    lines, _ = consensus.merge("۱- میشود کتاب ۲)", tess, 0)
    assert all(w.flag is None for w in lines[0].words)
    assert lines[0].words[1].text == "میشود"  # AI text is kept


def test_merge_flags_disagreement_with_alt() -> None:
    tess = [_tess_line([("مهلت", 90), ("تجدید", 90), ("نظر", 90), ("بیسن", 50), ("روز", 90)], 0.2)]
    lines, warnings = consensus.merge("مهلت تجدید نظر بیست روز", tess, 0)
    ws = lines[0].words
    assert ws[3].text == "بیست" and ws[3].flag == "disagree" and ws[3].alt == "بیسن"
    assert ws[3].bbox == tess[0].words[3].bbox
    assert [w.flag for w in ws[:3]] == [None, None, None]
    assert warnings == []


def test_merge_uneven_replacement_distributes_boxes() -> None:
    tess = [_tess_line([("الف", 90), ("غیرنافذ", 60), ("است", 90)], 0.3)]
    lines, _ = consensus.merge("الف غیر قابل نافذ است", tess, 0)
    ws = lines[0].words
    assert [w.text for w in ws] == ["الف", "غیر", "قابل", "نافذ", "است"]
    mid = ws[1:4]
    assert all(w.flag == "disagree" and w.alt == "غیرنافذ" for w in mid)
    # Boxes split over the Tesseract word, right to left.
    assert mid[0].bbox[0] > mid[1].bbox[0] > mid[2].bbox[0]
    union = tess[0].words[1].bbox
    assert mid[0].bbox[2] == pytest.approx(union[2]) and mid[2].bbox[0] == pytest.approx(union[0])


def test_merge_near_identical_split_is_agreement() -> None:
    tess = [_tess_line([("پذیرفته", 90), ("می", 90), ("شود", 90)], 0.3)]
    lines, _ = consensus.merge("پذیرفته می‌شود", tess, 0)
    assert [w.text for w in lines[0].words] == ["پذیرفته", "می‌شود"]
    assert all(w.flag is None for w in lines[0].words)


def test_merge_insertion_gets_estimated_box() -> None:
    tess = [_tess_line([("سه", 90), ("ماه", 90), ("است", 90)], 0.4)]
    lines, _ = consensus.merge("سه ماه کامل است", tess, 0)
    ws = lines[0].words
    assert ws[2].text == "کامل" and ws[2].flag == "disagree" and ws[2].alt == ""
    assert ws[2].bbox is not None
    # Between its neighbours (RTL: right of "است", left of "ماه").
    assert ws[1].bbox[0] >= ws[2].bbox[2] - 1e-9 and ws[2].bbox[0] >= ws[3].bbox[2] - 1e-9


def test_merge_follows_ai_line_structure_and_warns_on_omitted_line() -> None:
    tess = [
        _tess_line([("۱-", 90), ("متن", 90), ("سؤال", 90), ("اول", 90)], 0.1),
        _tess_line([("سطری", 90), ("کاملا", 90), ("جاافتاده", 90), ("اینجا", 90)], 0.15),
        _tess_line([("۱)", 90), ("گزینه", 90), ("یک", 90)], 0.2),
        _tess_line([("۲)", 90), ("گزینه", 90), ("دو", 90)], 0.25),
    ]
    ai = "۱- متن\nسؤال اول\n۱) گزینه یک\n۲) گزینه دو"
    lines, warnings = consensus.merge(ai, tess, 3)
    assert [ln.text for ln in lines] == ai.split("\n")
    assert all(ln.page == 3 for ln in lines)
    assert any("جاافتادن" in w for w in warnings)


def test_merge_low_agreement_falls_back_to_tesseract() -> None:
    tess = [_tess_line([("۱-", 90), ("متن", 90), ("واقعی", 90), ("صفحه", 90), ("این", 90)], 0.1)]
    lines, warnings = consensus.merge("چیزی کاملاً بی‌ربط و ساختگی درباره‌ی موضوع دیگر", tess, 0)
    assert lines is tess
    assert any("توافق" in w for w in warnings)


def test_merge_without_tesseract_words_keeps_ai_text() -> None:
    lines, warnings = consensus.merge("متن\nدوم", [], 0)
    assert [ln.text for ln in lines] == ["متن", "دوم"]
    assert warnings == []


# ------------------------------------------------------------------------- AI engines


def _fake_message(text: str, stop_reason: str = "end_turn"):
    return SimpleNamespace(
        stop_reason=stop_reason,
        content=[
            SimpleNamespace(type="thinking", thinking="..."),
            SimpleNamespace(type="text", text=text),
        ],
    )


class _FakeMessages:
    def __init__(self, results: list) -> None:
        self.results = results
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        r = self.results.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def _fake_client(beta_results: list, plain_results: list | None = None):
    beta = _FakeMessages(beta_results)
    plain = _FakeMessages(plain_results or [])
    return SimpleNamespace(beta=SimpleNamespace(messages=beta), messages=plain), beta, plain


def _status_error(cls, status: int, msg: str):
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls(msg, response=httpx.Response(status, request=req), body=None)


CLAUDE_SETTINGS = Settings(anthropic_api_key="sk-test", claude_effort="high")


def test_claude_request_shape_and_fence_stripping() -> None:
    client, beta, _ = _fake_client([_fake_message("```text\n۱- متن سؤال\n۱) گزینه\n```")])
    eng = llm.ClaudeEngine(CLAUDE_SETTINGS, client=client)
    assert eng.transcribe(b"\xff\xd8jpeg", "page") == "۱- متن سؤال\n۱) گزینه"
    call = beta.calls[0]
    assert call["model"] == CLAUDE_SETTINGS.claude_model
    assert call["betas"] == ["server-side-fallback-2026-07-01"]
    assert call["fallbacks"] == "default"
    assert call["output_config"] == {"effort": "high"}
    assert call["max_tokens"] == 16000
    assert not {"thinking", "temperature", "system"} & call.keys()
    msgs = call["messages"]
    assert len(msgs) == 1 and msgs[0]["role"] == "user"
    img, txt = msgs[0]["content"]
    assert img["source"]["media_type"] == "image/jpeg" and img["source"]["data"] == "/9hqcGVn"
    assert "رونویسی" in txt["text"]


def test_claude_region_prompt() -> None:
    client, beta, _ = _fake_client([_fake_message("متن")])
    llm.ClaudeEngine(CLAUDE_SETTINGS, client=client).transcribe(b"x", "region")
    assert "بریده" in beta.calls[0]["messages"][0]["content"][1]["text"]


def test_claude_refusal_raises() -> None:
    client, _, _ = _fake_client([_fake_message("", stop_reason="refusal")])
    with pytest.raises(llm.AiEngineError):
        llm.ClaudeEngine(CLAUDE_SETTINGS, client=client).transcribe(b"x")


def test_claude_retries_without_beta_when_relay_rejects_it() -> None:
    err = _status_error(anthropic.BadRequestError, 400, "unknown parameter: fallbacks")
    client, beta, plain = _fake_client([err], [_fake_message("متن")])
    eng = llm.ClaudeEngine(CLAUDE_SETTINGS, client=client)
    assert eng.transcribe(b"x") == "متن"
    assert "betas" not in plain.calls[0] and "fallbacks" not in plain.calls[0]
    # Remembered: next call goes straight to the plain endpoint.
    plain.results.append(_fake_message("دوم"))
    assert eng.transcribe(b"x") == "دوم"
    assert len(beta.calls) == 1


def test_claude_errors_become_ai_engine_errors() -> None:
    for exc in (
        _status_error(anthropic.RateLimitError, 429, "slow down"),
        _status_error(anthropic.AuthenticationError, 401, "bad key"),
        _status_error(anthropic.BadRequestError, 400, "image too large"),
        anthropic.APIConnectionError(request=httpx.Request("POST", "https://x")),
    ):
        client, _, _ = _fake_client([exc])
        with pytest.raises(llm.AiEngineError) as info:
            llm.ClaudeEngine(CLAUDE_SETTINGS, client=client).transcribe(b"x")
        assert info.value.__cause__ is exc


def test_gemini_request_and_response() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("x-goog-api-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={"candidates": [{"content": {"parts": [{"text": "۱- سؤال"}, {"text": "\n۱) الف"}]}}]},
        )

    s = Settings(gemini_api_key="g-key", gemini_base_url="https://relay.example/", gemini_model="m1")
    eng = llm.GeminiEngine(s, client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert eng.transcribe(b"\xff\xd8", "page") == "۱- سؤال\n۱) الف"
    assert seen["url"] == "https://relay.example/v1beta/models/m1:generateContent"
    assert seen["key"] == "g-key"
    parts = seen["body"]["contents"][0]["parts"]
    assert parts[0]["inline_data"]["mime_type"] == "image/jpeg"
    assert seen["body"]["generationConfig"] == {"temperature": 0}


def test_gemini_http_error() -> None:
    eng = llm.GeminiEngine(
        Settings(gemini_api_key="k"),
        client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(429))),
    )
    with pytest.raises(llm.AiEngineError):
        eng.transcribe(b"x")


def test_engine_factory_and_status() -> None:
    s = Settings(anthropic_api_key="", anthropic_base_url="", gemini_api_key="")
    assert llm.get_ai_engine("claude", s) is None
    assert llm.get_ai_engine("gemini", s) is None
    st = llm.engine_status(s)
    assert st["claude"] is False and st["gemini"] is False and isinstance(st["offline"], bool)
    s2 = Settings(anthropic_api_key="k", gemini_api_key="g")
    assert llm.get_ai_engine("claude", s2).name == "claude"
    assert llm.get_ai_engine("gemini", s2).name == "gemini"
    assert llm.engine_status(s2)["gemini"] is True


# ------------------------------------------------------------------------------ pipeline


class _FakeAi:
    name = "fake"

    def __init__(self, text: str | None = None, fail: bool = False) -> None:
        self.text, self.fail, self.calls = text, fail, []

    def transcribe(self, jpeg: bytes, mode: str = "page") -> str:
        self.calls.append(mode)
        assert jpeg[:2] == b"\xff\xd8"
        if self.fail:
            raise llm.AiEngineError("سرویس در دسترس نیست")
        return self.text or ""


def test_process_document_text_layer(tmp_path: Path) -> None:
    progress: list[tuple[int, int]] = []
    doc = pipeline.process_document(
        fg.booklet_pdf(), "booklet", "b.pdf", "offline", TESS, tmp_path,
        lambda d, t: progress.append((d, t)),
    )  # fmt: skip
    (page,) = doc.pages
    assert page.source == "text_layer" and page.engine == "text_layer"
    assert (tmp_path / "booklet-0.jpg").is_file() and (tmp_path / "booklet-0-orig.jpg").is_file()
    assert progress[-1] == (1, 1)
    assert similarity(lines_text(page.lines)) > 0.99


@needs_tesseract
def test_process_document_scan_with_ai_and_failure(
    tmp_path: Path, page_img: np.ndarray, monkeypatch: pytest.MonkeyPatch
) -> None:
    pdf = fg.image_pdf([fg.phone_scan(page_img), fg.hard_phone_scan(page_img)])
    ai = _FakeAi(fg.GROUND_TRUTH)
    monkeypatch.setattr(pipeline, "resolve_engine", lambda engine, settings: ai)
    s = TESS.model_copy(update={"render_dpi": 200})
    doc = pipeline.process_document(pdf, "explanations", "e.pdf", "claude", s, tmp_path, None)
    assert [p.index for p in doc.pages] == [0, 1]
    for p in doc.pages:
        assert p.source == "ocr" and p.engine == "fake+tesseract"
        assert any("پرسپکتیو" in x for x in p.preprocess)
        assert lines_text(p.lines) == fg.GROUND_TRUTH  # AI text wins, Tesseract boxes
        boxed = [w for ln in p.lines for w in ln.words if w.bbox]
        assert len(boxed) > 0.9 * sum(len(ln.words) for ln in p.lines)
        img = cv2.imread(str(tmp_path / f"explanations-{p.index}.jpg"))
        assert max(img.shape[:2]) <= pipeline.UI_MAX_SIDE
    assert ai.calls == ["page", "page"]

    # AI failure: Tesseract result is kept and the page carries a warning.
    monkeypatch.setattr(pipeline, "resolve_engine", lambda e, s: _FakeAi(fail=True))
    doc = pipeline.process_document(pdf, "booklet", "b.pdf", "claude", s, tmp_path, None)
    p = doc.pages[0]
    assert p.engine == "tesseract" and p.warnings and similarity(lines_text(p.lines)) > 0.9


@needs_tesseract
def test_reocr_region_maps_boxes_back(
    tmp_path: Path, variants: dict[str, np.ndarray], monkeypatch: pytest.MonkeyPatch
) -> None:
    gray, _ = preprocess(variants["clean"])
    path = tmp_path / "booklet-0.jpg"
    cv2.imwrite(str(path), pipeline._resize_max(gray, pipeline.UI_MAX_SIDE))
    full = ocr_tesseract(gray, 0, TESS)
    q2 = next(ln for ln in full if ln.text.startswith("۲-") or "کدام یک" in ln.text)
    region = (0.05, q2.bbox[1] - 0.005, 0.95, q2.bbox[3] + 0.005)
    lines = pipeline.reocr_region(path, region, "offline", TESS)
    assert lines and "کدام" in lines_text(lines)
    for ln in lines:
        for w in ln.words:
            assert region[1] - 0.02 <= w.bbox[1] and w.bbox[3] <= region[3] + 0.02
    # Same region via a (fake) AI engine in region mode.
    ai = _FakeAi("۲- کدام یک از موارد زیر از شرایط اساسی صحت معامله نیست؟")
    monkeypatch.setattr(pipeline, "resolve_engine", lambda e, s: ai)
    lines = pipeline.reocr_region(path, region, "claude", TESS)
    assert ai.calls == ["region"]
    assert lines_text(lines) == ai.text
