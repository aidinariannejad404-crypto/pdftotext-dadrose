from datetime import UTC, datetime

import httpx
import pytest

from app import export
from app.config import Settings
from app.export import DadroseError, push_to_dadrose, to_dadrose_payload
from app.models import Option, Project, Question


def make_project() -> Project:
    q1 = Question(
        number=2,
        subject_key="civil",
        stem="در عقد بیع <شرط> باطل کدام است؟",
        options=[Option(key=k, text=f"گزینه {k} & متن") for k in "4321"],
        correct_key="3",
        explanation="گزینه ۳ صحیح است.\nطبق ماده ۲۳۲ قانون مدنی",
        status="approved",
    )
    q2 = Question(number=1, subject_key="civil", stem="سؤال اول", status="pending")
    return Project(
        id="p1",
        title="آزمون کانون وکلا ۱۴۰۴",
        track="bar",
        year=1404,
        blueprint="BAR-1405",
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        questions=[q1, q2],
    )


def test_payload_shape():
    payload = to_dadrose_payload(make_project(), only_approved=False)
    assert payload["source"] == {
        "kind": "official",
        "track": "bar",
        "year": 1404,
        "title": "آزمون کانون وکلا ۱۴۰۴",
    }
    assert [q["source_number"] for q in payload["questions"]] == [1, 2]
    q = payload["questions"][1]
    assert set(q) == {
        "source_number",
        "subject_key",
        "stem_html",
        "options",
        "correct_key",
        "explanation_html",
    }
    assert q["stem_html"] == "<p>در عقد بیع &lt;شرط&gt; باطل کدام است؟</p>"
    assert q["options"][0] == {"key": "1", "order": 1, "text_html": "گزینه 1 &amp; متن"}
    assert [o["order"] for o in q["options"]] == [1, 2, 3, 4]
    assert q["correct_key"] == "3"
    assert q["explanation_html"] == "<p>گزینه ۳ صحیح است.</p><p>طبق ماده ۲۳۲ قانون مدنی</p>"
    assert payload["questions"][0]["explanation_html"] == ""


def test_only_approved():
    payload = to_dadrose_payload(make_project(), only_approved=True)
    assert [q["source_number"] for q in payload["questions"]] == [2]


def test_push_requires_configuration():
    with pytest.raises(DadroseError, match="تنظیم نشده"):
        push_to_dadrose({"questions": []}, Settings(dadrose_api_url="", dadrose_api_token=""))


def test_push_posts_with_bearer(monkeypatch):
    calls = {}

    def fake_post(url, json, headers, timeout):
        calls.update(url=url, json=json, headers=headers)
        return httpx.Response(201, json={"created": 1}, request=httpx.Request("POST", url))

    monkeypatch.setattr(export.httpx, "post", fake_post)
    settings = Settings(dadrose_api_url="https://api.dadrose.test/", dadrose_api_token="tok")
    assert push_to_dadrose({"questions": [1]}, settings) == {"created": 1}
    assert calls["url"] == "https://api.dadrose.test/api/v1/admin/questions/import"
    assert calls["headers"]["Authorization"] == "Bearer tok"


def test_push_non_2xx_raises(monkeypatch):
    def fake_post(url, **_):
        return httpx.Response(403, text="forbidden", request=httpx.Request("POST", url))

    monkeypatch.setattr(export.httpx, "post", fake_post)
    settings = Settings(dadrose_api_url="https://x.test", dadrose_api_token="tok")
    with pytest.raises(DadroseError, match="۴۰۳|403"):
        push_to_dadrose({}, settings)
