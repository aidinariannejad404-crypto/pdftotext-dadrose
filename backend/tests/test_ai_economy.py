"""Token economy: smart AI use, correction calls, cache, budget, usage accounting.
All AI engines are mocked; no network."""

from __future__ import annotations

import threading
from pathlib import Path
from types import SimpleNamespace

import anthropic
import cv2
import httpx
import numpy as np
import pytest

from app import pipeline
from app.config import Settings
from app.models import AiUsage, DocumentResult, Line, PageResult, Word
from app.ocr import llm
from app.ocr.flags import refine_low_conf_flags
from app.ocr.quality import page_quality
from tests import fixtures_gen as fg

GT_LINES = fg.GROUND_TRUTH_LINES


def _line(texts: list[str], y: float, conf: float = 95.0, page: int = 0) -> Line:
    words, x = [], 0.95
    for t in texts:
        w = 0.015 * max(1, len(t))
        words.append(Word(text=t, bbox=(x - w, y, x, y + 0.02), conf=conf))
        x -= w + 0.008
    return Line(page=page, words=words, bbox=(x, y, 0.95, y + 0.02))


def _gt_page_lines(page: int, corrupt: dict[tuple[int, int], str] | None = None) -> list[Line]:
    """Ground-truth lines as Tesseract would return them; `corrupt` replaces word (line, i)
    with a misread at low confidence."""
    lines = []
    for li, text in enumerate(GT_LINES):
        ln = _line(text.split(), 0.05 + li * 0.035, page=page)
        for (cl, ci), bad in (corrupt or {}).items():
            if cl == li:
                ln.words[ci] = Word(text=bad, bbox=ln.words[ci].bbox, conf=25.0)
        lines.append(ln)
    return lines


GARBAGE = "ققه نها حام فرارنا مسم سا ی ای سیب ار اه اس هنز ضوع اقا اک ار امیش ری اضرا اسر مضه"


def _garbage_lines(page: int) -> list[Line]:
    toks = GARBAGE.split()
    return [_line(toks[i : i + 6], 0.05 + i * 0.01, conf=30, page=page) for i in range(0, 60, 6)]


class FakeEngine:
    """Records calls; transcribes to the ground truth and fixes known misreads."""

    name = "fake"
    model = "fake-1"

    def __init__(self, corrections: list[dict] | None = None, fail: bool = False) -> None:
        self.calls: list[tuple[str, int, int]] = []  # (mode, image w, image h)
        self.prompts: list[list[str]] = []
        self.corrections = corrections
        self.fail = fail
        self.lock = threading.Lock()

    def _record(self, mode: str, jpeg: bytes) -> None:
        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_UNCHANGED)
        assert img.ndim == 2, "AI images must be grayscale"
        assert max(img.shape) <= pipeline.AI_MAX_SIDE
        with self.lock:
            self.calls.append((mode, img.shape[1], img.shape[0]))

    def transcribe_ex(self, jpeg: bytes, mode: str = "page") -> llm.AiResult:
        self._record(mode, jpeg)
        if self.fail:
            raise llm.AiEngineError("خطا")
        return llm.AiResult(
            text=fg.GROUND_TRUTH, usage=AiUsage(calls=1, input_tokens=1500, output_tokens=600)
        )

    def transcribe(self, jpeg: bytes, mode: str = "page") -> str:
        return self.transcribe_ex(jpeg, mode).text

    def correct(self, jpeg: bytes, lines: list[str]) -> llm.AiResult:
        self._record("correct", jpeg)
        with self.lock:
            self.prompts.append(lines)
        indices = [int(t.split(":", 1)[0]) for t in lines]
        return llm.AiResult(
            corrections=list(self.corrections or []),
            checked=indices,
            usage=AiUsage(calls=1, input_tokens=400, output_tokens=40),
        )

    def modes(self) -> list[str]:
        return sorted(m for m, _, _ in self.calls)


def _settings(tmp_path: Path, **kw) -> Settings:
    base = {
        "data_dir": tmp_path / "data", "render_dpi": 100, "page_workers": 2, "ai_cache": False,
        "default_ai_engine": "claude", "anthropic_api_key": "sk-test",
    }  # fmt: skip
    base.update(kw)
    return Settings(**base)


@pytest.fixture
def three_page_pdf() -> bytes:
    page = fg.render(fg.booklet_pdf(), 100)
    return fg.image_pdf([fg.clean_scan(page)] * 3)


@pytest.fixture
def fake_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    """Deterministic Tesseract stand-in: page 0 clean, page 1 two misreads, page 2 garbage."""

    def ocr(gray, page, settings, psm=None):
        if page == 0:
            return _gt_page_lines(0)
        if page == 1:
            # line 0 word 4 "مستأجر" → "مستاحر", line 7 word 1 "اهلیت" → "اهلبت"
            return _gt_page_lines(1, {(0, 4): "مستاحر", (7, 1): "اهلبت"})
        return _garbage_lines(page)

    monkeypatch.setattr(pipeline, "ocr_tesseract", ocr)


def _run(pdf: bytes, engine_name: str, ai: FakeEngine, settings: Settings, tmp_path: Path,
         monkeypatch: pytest.MonkeyPatch, budget: pipeline.AiBudget | None = None):  # fmt: skip
    monkeypatch.setattr(pipeline, "resolve_engine", lambda e, s: None if e == "offline" else ai)
    return pipeline.process_document(
        pdf, "booklet", "b.pdf", engine_name, settings, tmp_path / "out", None, budget
    )


# ------------------------------------------------------------------------------ quality


def _page(lines: list[Line]) -> PageResult:
    return PageResult(index=0, width=10, height=10, source="ocr", engine="tesseract", lines=lines)


def _refined(lines: list[Line]) -> PageResult:
    page = _page(lines)
    refine_low_conf_flags(DocumentResult(kind="booklet", filename="x", pages=[page]))
    return page


def test_quality_scores() -> None:
    good = page_quality(_refined(_gt_page_lines(0)))
    bad = page_quality(_refined(_garbage_lines(0)))
    assert good >= 0.9
    assert bad < 0.45
    assert page_quality(_page([])) == 0.0
    assert page_quality(_page([]), ink_ratio=0.0005) == 1.0  # blank sheet
    # Lots of ink but only a few words recognized → low coverage.
    few = _page([_line(["این", "متن", "است"], 0.1)])
    assert page_quality(few, ink_ratio=0.05) < 0.2


def test_decide_ai_mode() -> None:
    p = _page(_gt_page_lines(0))
    p.quality = 0.95
    assert pipeline.decide_ai_mode(p, "smart", 0.6) == "none"
    assert pipeline.decide_ai_mode(p, "always", 0.6) == "transcribe"
    assert pipeline.decide_ai_mode(p, "never", 0.6) == "none"
    assert pipeline.decide_ai_mode(p, "always", 0.6, blank=True) == "none"
    p.lines[2].words[0].flag = "low_conf"
    assert pipeline.decide_ai_mode(p, "smart", 0.6) == "correct"
    p.quality = 0.3
    assert pipeline.decide_ai_mode(p, "smart", 0.6) == "transcribe"
    p.source = "text_layer"
    assert pipeline.decide_ai_mode(p, "always", 0.6) == "none"


# ------------------------------------------------------------------- smart vs always


def test_smart_mode_uses_ai_only_where_needed(
    tmp_path: Path, three_page_pdf: bytes, fake_ocr: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    ai = FakeEngine(
        corrections=[
            {"line": 0, "from": "مستاحر", "to": "مستأجر"},
            {"line": 7, "from": "اهلبت", "to": "اهلیت"},
            {"line": 7, "from": "ناموجود", "to": "هرچیز"},  # bogus `from`: ignored
            {"line": 15, "from": "ده", "to": "صد"},  # line not sent: ignored
        ]
    )
    doc = _run(three_page_pdf, "auto", ai, _settings(tmp_path), tmp_path, monkeypatch)
    p0, p1, p2 = doc.pages
    assert [p.ai_mode for p in doc.pages] == ["none", "correct", "transcribe"]
    assert ai.modes() == ["correct", "page"]
    assert all(p.quality is not None for p in doc.pages)
    assert p0.quality >= 0.9 and p2.quality < 0.6
    assert p0.engine == "tesseract" and p0.ai_usage == AiUsage()

    # Corrections applied, originals kept in alt, flags cleared on checked lines.
    assert p1.engine == "tesseract+fake"
    assert p1.lines[0].words[4].text == "مستأجر" and p1.lines[0].words[4].alt == "مستاحر"
    assert p1.lines[7].words[1].text == "اهلیت"
    assert all(w.flag is None for ln in p1.lines for w in ln.words)
    assert lines_text(p1) == fg.GROUND_TRUTH
    # Only flagged lines (+ neighbours) were sent, with ⟦⟧ marks.
    (sent,) = ai.prompts
    assert [int(t.split(":")[0]) for t in sent] == [0, 1, 6, 7, 8]
    assert "⟦مستاحر⟧" in sent[0] and "⟦" not in sent[1]
    # The correction image is a crop, much smaller than the page.
    _, cw, ch = next(c for c in ai.calls if c[0] == "correct")
    _, pw, ph = next(c for c in ai.calls if c[0] == "page")
    assert cw * ch < 0.6 * pw * ph

    assert lines_text(p2) == fg.GROUND_TRUTH and p2.engine == "fake+tesseract"
    assert p1.ai_usage == AiUsage(calls=1, input_tokens=400, output_tokens=40)
    assert p2.ai_usage == AiUsage(calls=1, input_tokens=1500, output_tokens=600)


def lines_text(page: PageResult) -> str:
    return "\n".join(ln.text for ln in page.lines)


def test_explicit_engine_transcribes_every_ocr_page(
    tmp_path: Path, three_page_pdf: bytes, fake_ocr: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    ai = FakeEngine()
    doc = _run(three_page_pdf, "claude", ai, _settings(tmp_path), tmp_path, monkeypatch)
    assert [p.ai_mode for p in doc.pages] == ["transcribe"] * 3
    assert ai.modes() == ["page"] * 3
    total = AiUsage()
    for p in doc.pages:
        total.add(p.ai_usage)
    assert total == AiUsage(calls=3, input_tokens=4500, output_tokens=1800)


def test_offline_never_calls_ai(
    tmp_path: Path, three_page_pdf: bytes, fake_ocr: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    ai = FakeEngine()
    doc = _run(three_page_pdf, "offline", ai, _settings(tmp_path), tmp_path, monkeypatch)
    assert ai.calls == [] and {p.ai_mode for p in doc.pages} == {"none"}
    assert doc.pages[2].quality < 0.6  # quality is still reported


def test_text_layer_pages_never_use_ai(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ai = FakeEngine()
    doc = _run(fg.booklet_pdf(), "claude", ai, _settings(tmp_path), tmp_path, monkeypatch)
    assert ai.calls == [] and doc.pages[0].source == "text_layer"
    assert doc.pages[0].quality is None


def test_ai_failure_keeps_offline_result(
    tmp_path: Path, three_page_pdf: bytes, fake_ocr: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    ai = FakeEngine(fail=True)
    doc = _run(three_page_pdf, "auto", ai, _settings(tmp_path), tmp_path, monkeypatch)
    p2 = doc.pages[2]
    assert p2.ai_mode == "none" and p2.engine == "tesseract" and p2.warnings
    assert "ققه" in lines_text(p2)


# ------------------------------------------------------------------------ cache, budget


def test_cache_hit_on_second_run(
    tmp_path: Path, three_page_pdf: bytes, fake_ocr: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    s = _settings(tmp_path, ai_cache=True)
    ai = FakeEngine(corrections=[{"line": 0, "from": "مستاحر", "to": "مستأجر"}])
    _run(three_page_pdf, "auto", ai, s, tmp_path, monkeypatch)
    assert len(ai.calls) == 2
    assert any((tmp_path / "data" / "ai-cache").rglob("*.json"))

    ai2 = FakeEngine(corrections=[{"line": 0, "from": "مستاحر", "to": "WRONG"}])
    doc = _run(three_page_pdf, "auto", ai2, s, tmp_path, monkeypatch)
    assert ai2.calls == []  # served from the cache
    p1, p2 = doc.pages[1], doc.pages[2]
    assert p1.ai_usage == AiUsage(cached=1) and p2.ai_usage == AiUsage(cached=1)
    assert p1.lines[0].words[4].text == "مستأجر"  # the cached answer, not the new engine's
    assert lines_text(p2) == fg.GROUND_TRUTH


def test_budget_exhaustion(
    tmp_path: Path, three_page_pdf: bytes, fake_ocr: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    ai = FakeEngine()
    budget = pipeline.AiBudget(1)
    doc = _run(three_page_pdf, "claude", ai, _settings(tmp_path), tmp_path, monkeypatch, budget)
    assert len(ai.calls) == 1 and budget.exhausted
    over = [p for p in doc.pages if pipeline.BUDGET_WARNING in p.warnings]
    assert len(over) == 2 and all(p.ai_mode == "none" for p in over)

    # Default budget comes from settings.
    ai = FakeEngine()
    s = _settings(tmp_path, ai_max_calls_per_project=2)
    doc = _run(three_page_pdf, "claude", ai, s, tmp_path, monkeypatch)
    assert len(ai.calls) == 2


def test_budget_is_thread_safe() -> None:
    budget = pipeline.AiBudget(100)
    granted: list[bool] = []
    lock = threading.Lock()

    def worker() -> None:
        for _ in range(50):
            ok = budget.take()
            with lock:
                granted.append(ok)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(granted) == 100 and budget.used == 100


# ------------------------------------------------------------------ correction details


def test_apply_corrections_zwnj_and_guards() -> None:
    page = _page(
        [
            _line(["پذیرفته", "می", "شود"], 0.1),
            _line(["قرارداد", "باطل", "است"], 0.2),
            _line(["متن", "دیگر"], 0.3),
        ]
    )
    page.lines[0].words[1].flag = "low_conf"
    page.lines[1].words[1].flag = "low_conf"
    page.lines[2].words[0].flag = "low_conf"
    res = llm.AiResult(
        corrections=[
            {"line": 0, "from": "می‌شود", "to": "می‌شود"},  # same text modulo ZWNJ: no-op
            {"line": 0, "from": "می شود", "to": "می‌شوند"},  # two words → one
            {"line": 1, "from": "باطل", "to": "باطل است و هیچ اثری ندارد"},  # rewrite: ignored
            {"line": 1, "from": "صحیح", "to": "غلط"},  # not in line: ignored
            {"line": 2, "from": "متن", "to": "مثن"},  # line not sent: ignored
            {"line": 9, "from": "x", "to": "y"},
        ],
        checked=[0],
    )
    n = pipeline.apply_corrections(page, res, sent={0, 1})
    assert n == 1
    assert [w.text for w in page.lines[0].words] == ["پذیرفته", "می‌شوند"]
    assert page.lines[0].words[1].alt == "می شود" and page.lines[0].words[1].flag is None
    assert page.lines[0].words[1].bbox is not None
    assert page.lines[1].words[1].text == "باطل"
    assert page.lines[1].words[1].flag == "low_conf"  # line 1 not confirmed as checked
    assert page.lines[2].words[0].flag == "low_conf"


def test_apply_corrections_arabic_letter_variants() -> None:
    page = _page([_line(["كتاب", "قانون"], 0.1)])
    page.lines[0].words[0].flag = "low_conf"
    res = llm.AiResult(corrections=[{"line": 0, "from": "⟦کتاب⟧", "to": "کتب"}], checked=[0])
    assert pipeline.apply_corrections(page, res, {0}) == 1
    assert page.lines[0].words[0].text == "کتب"


def test_correction_request_stacks_few_crops() -> None:
    lines = _gt_page_lines(0)
    for i in (0, 1, 9, 10, 18):
        lines[i].words[1].flag = "low_conf"
    page = _page(lines)
    img = np.full((2000, 1414), 255, np.uint8)
    req = pipeline.build_correction_request(page, img)
    assert req is not None
    assert req.sent == {0, 1, 2, 8, 9, 10, 11, 17, 18, 19}
    out = cv2.imdecode(np.frombuffer(req.jpeg, np.uint8), cv2.IMREAD_UNCHANGED)
    assert out.ndim == 2 and out.shape[0] < 0.5 * 2000 * (out.shape[1] / 1414)
    assert pipeline.build_correction_request(_page(_gt_page_lines(0)), img) is None


def test_parse_corrections_variants() -> None:
    obj = '{"checked": [1, 2], "corrections": [{"line": 1, "from": "a", "to": "b"}, {"x": 1}]}'
    assert llm.parse_corrections(obj) == ([{"line": 1, "from": "a", "to": "b"}], [1, 2])
    bare = 'Here you go:\n```json\n[{"line": 3, "from": "c", "to": "d"}]\n```'
    assert llm.parse_corrections(bare) == ([{"line": 3, "from": "c", "to": "d"}], [])
    with pytest.raises(llm.AiEngineError):
        llm.parse_corrections("no json here")


# ------------------------------------------------------------------- engines (mocked)


class _Msgs:
    def __init__(self, results: list) -> None:
        self.results, self.calls = results, []

    def create(self, **kw):
        self.calls.append(kw)
        r = self.results.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def _msg(text: str, stop: str = "end_turn", **usage):
    u = {"input_tokens": 100, "output_tokens": 20} | usage
    return SimpleNamespace(
        stop_reason=stop,
        content=[SimpleNamespace(type="text", text=text)],
        usage=SimpleNamespace(**u),
    )


def _bad_request(msg: str) -> anthropic.BadRequestError:
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return anthropic.BadRequestError(msg, response=httpx.Response(400, request=req), body=None)


def test_claude_correct_uses_structured_output_and_reports_usage() -> None:
    beta = _Msgs(
        [_msg('{"checked":[0],"corrections":[{"line":0,"from":"a","to":"b"}]}',
              cache_read_input_tokens=50, cache_creation_input_tokens=None)]
    )  # fmt: skip
    client = SimpleNamespace(beta=SimpleNamespace(messages=beta), messages=_Msgs([]))
    s = Settings(anthropic_api_key="k", ai_ocr_effort="low")
    res = llm.ClaudeEngine(s, client=client).correct(b"\xff\xd8", ["0: ⟦a⟧ c"])
    assert res.corrections == [{"line": 0, "from": "a", "to": "b"}] and res.checked == [0]
    assert res.usage == AiUsage(calls=1, input_tokens=150, output_tokens=20)
    call = beta.calls[0]
    assert call["max_tokens"] == llm.MAX_TOKENS["correct"]
    assert call["output_config"]["effort"] == "low"
    assert call["output_config"]["format"]["type"] == "json_schema"
    assert call["system"] == llm.SYSTEM_CORRECT
    assert "0: ⟦a⟧ c" in call["messages"][0]["content"][1]["text"]


def test_claude_correct_falls_back_to_prompt_json() -> None:
    beta = _Msgs(
        [
            _bad_request("output_config.format: unsupported"),
            _msg('{"checked":[0],"corrections":[]}'),
        ]
    )
    client = SimpleNamespace(beta=SimpleNamespace(messages=beta), messages=_Msgs([]))
    eng = llm.ClaudeEngine(Settings(anthropic_api_key="k"), client=client)
    res = eng.correct(b"\xff\xd8", ["0: x"])
    assert res.checked == [0] and res.corrections == []
    assert "format" not in beta.calls[1]["output_config"]
    assert eng._use_format is False


def test_claude_truncated_correction_verifies_nothing() -> None:
    beta = _Msgs([_msg('{"checked":[0],"corr', stop="max_tokens")])
    client = SimpleNamespace(beta=SimpleNamespace(messages=beta), messages=_Msgs([]))
    res = llm.ClaudeEngine(Settings(anthropic_api_key="k"), client=client).correct(b"x", ["0: a"])
    assert res.complete is False and res.checked == [] and res.usage.calls == 1


def test_gemini_correct_json_mode_and_usage() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {"content": {"parts": [{"text": '{"checked":[2],"corrections":[]}'}]}}
                ],
                "usageMetadata": {
                    "promptTokenCount": 300, "candidatesTokenCount": 12, "thoughtsTokenCount": 3,
                },
            },
        )  # fmt: skip

    s = Settings(gemini_api_key="g", gemini_model="gemini-2.5-flash", ai_ocr_effort="low")
    eng = llm.GeminiEngine(s, client=httpx.Client(transport=httpx.MockTransport(handler)))
    res = eng.correct(b"\xff\xd8", ["2: x"])
    assert res.checked == [2]
    assert res.usage == AiUsage(calls=1, input_tokens=300, output_tokens=15)
    gen = seen["body"]["generationConfig"]
    assert gen["responseMimeType"] == "application/json"
    assert "additionalProperties" not in str(gen["responseSchema"])
    assert gen["maxOutputTokens"] == llm.MAX_TOKENS["correct"]
    assert gen["thinkingConfig"] == {"thinkingBudget": 0}


# ------------------------------------------------------------------------ region re-OCR


def test_reocr_region_ex_usage_and_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    img = fg.render(fg.booklet_pdf(), 100)
    path = tmp_path / "p.jpg"
    cv2.imwrite(str(path), cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
    monkeypatch.setattr(pipeline, "ocr_tesseract", lambda *a, **k: _gt_page_lines(0)[:5])
    ai = FakeEngine()
    monkeypatch.setattr(pipeline, "resolve_engine", lambda e, s: ai)
    s = _settings(tmp_path, ai_cache=True)
    lines, usage = pipeline.reocr_region_ex(path, (0.1, 0.05, 0.9, 0.3), "claude", s)
    assert lines and usage == AiUsage(calls=1, input_tokens=1500, output_tokens=600)
    assert ai.modes() == ["region"]
    lines2, usage2 = pipeline.reocr_region_ex(path, (0.1, 0.05, 0.9, 0.3), "claude", s)
    assert usage2 == AiUsage(cached=1) and len(ai.calls) == 1
    assert [ln.text for ln in lines2] == [ln.text for ln in lines]
    # Compatibility wrapper.
    assert pipeline.reocr_region(path, (0.1, 0.05, 0.9, 0.3), "claude", s)


def test_merge_trust_ai_on_poor_pages() -> None:
    from app.ocr import consensus

    tess = [_line(["قفه", "نها", "حام"], 0.1, conf=30), _line(["قانون", "مدنی"], 0.2, conf=92)]
    ai = "قانون اساسی کشور\nقانون مدنی است"
    lines, warnings = consensus.merge(ai, tess, 0)
    assert lines is tess  # default: low agreement → keep Tesseract
    lines, warnings = consensus.merge(ai, tess, 0, trust_ai=True)
    assert [ln.text for ln in lines] == ai.split("\n")
    assert warnings
    # Unsure or missing Tesseract readings don't dispute the AI.
    assert all(w.flag is None for ln in lines for w in ln.words)
