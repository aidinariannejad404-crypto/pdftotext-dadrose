"""Smart mode's last resort: AI re-read of only the structurally broken questions."""

from __future__ import annotations

from datetime import UTC, datetime

from app import pipeline
from app.config import Settings
from app.jobs import JobRunner
from app.models import AiUsage, DocInfo, Line, Option, Project, Question, Region, Word
from app.store import Store


def _lines(*texts: str) -> list[Line]:
    return [
        Line(
            page=0,
            words=[Word(text=w, bbox=(0.1, 0.1 * i, 0.2, 0.1 * i + 0.05)) for w in t.split()],
        )
        for i, t in enumerate(texts, start=1)
    ]


def _project(questions: list[Question]) -> Project:
    return Project(
        id="p1",
        title="t",
        engine="auto",
        mode="questions",
        created_at=datetime.now(UTC),
        documents=[DocInfo(kind="booklet", filename="b.pdf", page_count=1)],
        questions=questions,
    )


def test_only_broken_questions_are_reread(tmp_path, monkeypatch):
    calls = []

    def fake_reocr(image, bbox, engine, settings, page=0, budget=None):
        calls.append(bbox)
        lines = _lines("۲- کدام گزینه صحیح است؟", "۱) اول", "۲) دوم", "۳) سوم", "۴) چهارم")
        return lines, AiUsage(calls=1, input_tokens=300, output_tokens=40)

    monkeypatch.setattr(pipeline, "reocr_region_ex", fake_reocr)
    monkeypatch.setattr(pipeline, "resolve_engine", lambda engine, settings: object())
    region = Region(doc="booklet", page=0, bbox=(0.1, 0.1, 0.9, 0.3))
    good = Question(
        number=1,
        stem="سؤال سالم",
        correct_key="1",
        regions=[region],
        options=[Option(key=str(k), text=f"گزینه {k}") for k in range(1, 5)],
    )
    broken = Question(
        number=2,
        stem="کدام گزینه صحیح است؟",
        correct_key="2",
        regions=[region],
        options=[Option(key="1", text="اول"), Option(key="2", text="دوم")],
    )
    settings = Settings(data_dir=tmp_path, ai_cache=False)
    runner = JobRunner(Store(tmp_path), settings)
    project = _project([good, broken])
    runner._repair_broken_questions(project, budget=None)

    assert len(calls) == 1  # the healthy question was not sent
    assert [o.text for o in broken.options] == ["اول", "دوم", "سوم", "چهارم"]
    assert broken.correct_key == "2"
    assert project.stats.ai_usage.calls == 1 and project.stats.ai_usage.input_tokens == 300
    runner.shutdown()


def test_no_ai_configured_means_no_repair(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, "resolve_engine", lambda engine, settings: None)
    monkeypatch.setattr(
        pipeline, "reocr_region_ex", lambda *a, **k: (_ for _ in ()).throw(AssertionError)
    )
    broken = Question(
        number=1, stem="", options=[], regions=[Region(doc="booklet", page=0, bbox=(0, 0, 1, 1))]
    )
    runner = JobRunner(Store(tmp_path), Settings(data_dir=tmp_path, ai_cache=False))
    runner._repair_broken_questions(_project([broken]), budget=None)
    assert broken.options == []
    runner.shutdown()
