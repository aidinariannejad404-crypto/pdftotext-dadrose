from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from types import SimpleNamespace

import anthropic
import httpx
import pytest

from app import ai_classify
from app.ai_classify import classify_with_ai
from app.classify import (
    classify_project,
    classify_question,
    extract_articles,
    format_article,
    law_key_for_name,
    laws_for_api,
    primary_article,
    taxonomy_for_api,
)
from app.config import Settings
from app.export import to_dadrose_payload
from app.export_docx import build_lines
from app.models import ArticleRef, Option, Project, Question
from app.ocr.llm import AiEngineError
from app.parser import build_questions
from app.validate import validate_question
from tests.test_parser import PAGE_BREAK, make_doc


def refs(text: str, context: str | None = None) -> list[tuple]:
    return [
        (r.law_key, r.kind, r.number, r.clause, r.source)
        for r in extract_articles(text, "stem", context)
    ]


def q(number: int = 1, stem: str = "", options=(), explanation: str = "", **kw) -> Question:
    return Question(
        number=number,
        stem=stem,
        options=[Option(key=str(i), text=t) for i, t in enumerate(options, start=1)],
        explanation=explanation,
        **kw,
    )


# ------------------------------------------------------------ article extraction


def test_extract_basic_forms():
    assert refs("طبق ماده ۱۹۰ ق.م") == [("civil_code", "ماده", "۱۹۰", "", "text")]
    assert refs("مطابق ماده‌ی ۲ قانون تجارت") == [("commercial_code", "ماده", "۲", "", "text")]
    assert refs("ماده 190 قانون مدنی") == [("civil_code", "ماده", "۱۹۰", "", "text")]
    assert refs("به استناد ماده ۳۴۸ ق.م.ا") == [("islamic_penal_code", "ماده", "۳۴۸", "", "text")]
    assert refs("ماده ۶ قانون تجارت الکترونیکی")[0][0] == "e_commerce"
    assert refs("ماده ۱۰ آیین دادرسی مدنی")[0][0] == "civil_procedure_code"
    assert refs("ماده ۸۴ ق.آ.د.م")[0][0] == "civil_procedure_code"


def test_extract_lists_ranges_and_clauses():
    assert [r[2] for r in refs("مواد ۱۰ و ۱۱ قانون مدنی")] == ["۱۰", "۱۱"]
    assert [r[2] for r in refs("مواد ۱۰ تا ۱۲ قانون مدنی")] == ["۱۰", "۱۱", "۱۲"]
    assert refs("بند ۳ ماده‌ی ۲ قانون تجارت") == [("commercial_code", "ماده", "۲", "بند ۳", "text")]
    assert refs("تبصره ۱ ماده ۱۰ قانون صدور چک") == [
        ("cheque_act", "ماده", "۱۰", "تبصره ۱", "text")
    ]
    assert refs("ماده ۱۰ مکرر قانون مجازات اسلامی")[0][2] == "۱۰ مکرر"
    assert refs("بند «الف» ماده ۱۳۰ لایحه اصلاحی قسمتی از قانون تجارت") == [
        ("companies_bill_1347", "ماده", "۱۳۰", "بند الف", "text")
    ]


def test_extract_constitution_and_back_references():
    assert refs("اصل ۴۹ قانون اساسی") == [("constitution", "اصل", "۴۹", "", "text")]
    assert refs("مطابق اصل ۱۶۷") == [("constitution", "اصل", "۱۶۷", "", "text")]
    found = refs("ماده ۱۰ قانون مدنی و نیز ماده ۲۲۰ همان قانون")
    assert found == [
        ("civil_code", "ماده", "۱۰", "", "text"),
        ("civil_code", "ماده", "۲۲۰", "", "text"),
    ]


def test_extract_bare_articles_use_context():
    assert refs("طبق ماده ۱۰ عقد صحیح است") == []
    assert refs("طبق ماده ۱۰ عقد صحیح است", "civil_code") == [
        ("civil_code", "ماده", "۱۰", "", "rules")
    ]
    # an earlier explicit law in the same text wins over the context
    assert refs("ماده ۱ قانون تجارت ... و ماده ۲", "civil_code")[1][0] == "commercial_code"


def test_extract_unknown_law_dedupe_and_non_matches():
    found = extract_articles("ماده واحده قانون حمایت از حقوق مؤلفان و مصنفان")
    assert found[0].number == "واحده" and found[0].law_key is None
    assert found[0].law == "قانون حمایت از حقوق مولفان و مصنفان"
    assert len(refs("ماده ۱۹۰ ق.م و باز هم ماده ۱۹۰ قانون مدنی")) == 1
    assert refs("ماده مخدر صنعتی") == []
    assert refs("۲ ماده از قانون") == []
    assert refs("اصول فقه و اصل برائت") == []


def test_law_lookup_and_api_lists():
    assert law_key_for_name("ق. م.") == "civil_code"
    assert law_key_for_name("قانون آیین دادرسی کیفری") == "criminal_procedure_code"
    assert law_key_for_name("قانونی ناشناخته") is None
    keys = {law["key"] for law in laws_for_api()}
    assert {"civil_code", "constitution", "cheque_act"} <= keys
    taxonomy = taxonomy_for_api()
    assert "بیع" in taxonomy["civil"] and "ورشکستگی" in taxonomy["commercial"]


# ------------------------------------------------------------------ classification

SAMPLES = [
    (
        q(stem="در عقد وکالت، عزل وکیل قبل از اطلاع وی چه اثری دارد؟", options=["الف", "ب"]),
        "civil",
        "وکالت",
    ),
    (
        q(
            stem="تاجری که پس از توقف، دفاتر خود را مخفی کرده است ورشکسته به تقلب است؟",
            explanation="طبق ماده ۵۴۹ قانون تجارت ...",
        ),
        "commercial",
        "ورشکستگی",
    ),
    (
        q(stem="در قتل عمد، اولیای دم کدام حق را دارند؟ قصاص یا دیه؟"),
        "criminal",
        "قصاص",
    ),
    (
        q(stem="صدور قرار بازداشت موقت در کدام جرائم الزامی است و نظارت قضایی چگونه است؟"),
        "criminal_procedure",
        "قرارهای تأمین و نظارت قضایی",
    ),
    (
        q(stem="مطابق ماده ۳۱۰ ق.آ.د.م در امور فوری چه تصمیمی گرفته می‌شود؟"),
        "civil_procedure",
        "دستور موقت",
    ),
    (
        q(stem="به موجب اصل ۹۱ قانون اساسی، اعضای کدام نهاد را رهبری تعیین می‌کند؟"),
        "constitutional",
        "شورای نگهبان",
    ),
    (
        q(stem="مهلت اعتراض به ثبت و تحدید حدود ملک چقدر است؟"),
        "registration_law",
        "ثبت عمومی و ثبت ملک",
    ),
]


@pytest.mark.parametrize(("question", "subject", "topic"), SAMPLES)
def test_classify_subjects_and_topics(question, subject, topic):
    classify_question(question)
    assert question.subject_key == subject
    assert question.topic == topic
    assert question.classification.subject_source in ("text", "rules")
    assert question.classification.topic_source == "rules"


def test_article_range_picks_most_specific_topic():
    question = q(stem="طبق ماده ۲۳۴ قانون مدنی کدام شرط باطل است؟")
    classify_question(question)
    assert question.subject_key == "civil"
    assert question.topic == "شروط ضمن عقد"  # 232–246 inside the general 183–300
    assert question.articles[0].number == "۲۳۴"


def test_blueprint_range_beats_law_reference():
    question = q(number=25, stem="مطابق ماده ۱۹۰ قانون مدنی، دعوای اعتبار معامله ...")
    classify_question(question, blueprint="BAR-1405")
    assert question.subject_key == "civil_procedure"
    assert question.classification.subject_source == "blueprint"
    assert question.classification.subject_confidence == 1.0


def test_default_subject_and_document_hint():
    unknown = q(number=3, stem="کدام گزینه صحیح است؟")
    known = [
        q(number=1, stem="طبق ماده ۱۹۰ ق.م کدام صحیح است؟"),
        q(number=2, stem="مطابق ماده ۳۳۸ قانون مدنی بیع چیست؟"),
    ]
    classify_project([*known, unknown])
    assert unknown.subject_key == "civil" and unknown.classification.subject_source == "rules"
    alone = q(stem="کدام گزینه صحیح است؟")
    classify_project([alone], default_subject="commercial")
    assert alone.subject_key == "commercial" and alone.classification.subject_source == "default"


def test_manual_fields_are_preserved():
    question = q(stem="طبق ماده ۴۶۶ قانون مدنی اجاره چیست؟")
    question.subject_key, question.topic = "fiqh_bar", "موضوع دستی"
    question.classification.subject_source = "manual"
    question.classification.topic_source = "manual"
    manual_ref = ArticleRef(law="قانون مدنی", law_key="civil_code", number="۱", source="manual")
    question.articles = [manual_ref]
    classify_question(question)
    assert question.subject_key == "fiqh_bar" and question.topic == "موضوع دستی"
    assert question.articles == [manual_ref]


def test_build_questions_uses_book_headings_for_topics():
    text = f"""
بخش دوم: حقوق تجارت
فصل دوم: ورشکستگی
۱- تاجر ورشکسته از چه زمانی از مداخله در اموال خود ممنوع است؟ (وکالت -۸۸)
الف) از تاریخ توقف ب) از تاریخ صدور حکم
ج) از تاریخ تشکیل هیئت طلبکاران د) هیچ‌کدام
گزینه‌ی «ب» درست است. طبق ماده‌ی ۴۱۸ قانون تجارت تاجر ورشکسته از تاریخ صدور حکم ممنوع است.
فصل سوم: مسائل متفرقه
۲- کدام گزینه درباره‌ی اسناد تجاری صحیح است؟
الف) یک ب) دو ج) سه د) چهار
گزینه‌ی «الف» درست است. توضیح.
{PAGE_BREAK}
۳- سؤال سوم همین فصل؟
الف) یک ب) دو ج) سه د) چهار
گزینه‌ی «ج» درست است.
"""
    result = build_questions(make_doc(text), None, "auto")
    by_number = {x.number: x for x in result.questions}
    q1, q2, q3 = by_number[1], by_number[2], by_number[3]
    assert q1.classification.section_path == ["بخش دوم: حقوق تجارت", "فصل دوم: ورشکستگی"]
    assert q1.subject_key == "commercial"
    assert q1.topic == "ورشکستگی" and q1.classification.topic_source == "heading"
    assert [(a.law_key, a.number) for a in q1.articles] == [("commercial_code", "۴۱۸")]
    assert q2.classification.section_path[-1] == "فصل سوم: مسائل متفرقه"
    assert q2.topic == "مسائل متفرقه"  # no taxonomy match: the chapter title is kept
    assert q3.topic == "مسائل متفرقه"  # carries across the page break
    assert q2.subject_key == "commercial"


def test_validation_topic_and_unknown_law():
    question = q(stem="سؤال", options=["a", "b", "c", "d"], subject_key="civil", correct_key="1")
    question.articles = [ArticleRef(law="قانون ناشناخته", number="۲")]
    codes = {i.code for i in validate_question(question, False)}
    assert {"missing_topic", "article_unknown_law"} <= codes
    question.topic = "بیع"
    question.subject_key = "usul_fiqh"
    question.articles = []
    codes = {i.code for i in validate_question(question, False)}
    assert "missing_topic" not in codes and "article_unknown_law" not in codes


# -------------------------------------------------------------------------- export


def _project() -> Project:
    question = q(
        number=4,
        stem="کدام شخص تاجر نیست؟",
        options=["دلال", "حق‌العمل‌کار", "عامل", "قائم‌مقام تجارتی"],
        explanation="گزینه‌ی «د» درست است. طبق بند ۳ ماده ۲ قانون تجارت ...\nماده: توضیح دوم",
        correct_key="4",
        subject_key="commercial",
    )
    classify_question(question)
    return Project(
        id="p",
        title="مجموعه تست تجارت",
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        questions=[question],
    )


def test_payload_has_topic_and_articles():
    payload = to_dadrose_payload(_project(), only_approved=False)
    item = payload["questions"][0]
    assert item["topic"] == "تاجر و اعمال تجارتی"
    assert item["articles"] == [
        {
            "law": "قانون تجارت",
            "law_key": "commercial_code",
            "kind": "ماده",
            "number": "۲",
            "clause": "بند ۳",
        }
    ]


def test_docx_meta_lines_inside_question_block():
    project = _project()
    assert format_article(primary_article(project.questions[0])) == "۲ قانون تجارت"
    lines = build_lines(project, only_approved=False, exam_header=False)
    start = lines.index(next(x for x in lines if x.startswith("سوال 1:")))
    block = lines[start : lines.index("", start)]
    meta = [x for x in block if re.match(r"^(درس|مبحث|ماده|منبع)\s*:", x)]
    assert meta == [
        "درس: حقوق تجارت",
        "مبحث: تاجر و اعمال تجارتی",
        "ماده: ۲ قانون تجارت",
        "منبع: مجموعه تست تجارت",
    ]
    # an explanation line that starts like a meta line was glued, not emitted as meta
    assert sum(1 for x in block if x.startswith("ماده:")) == 1


# ------------------------------------------------------------------------------ AI


def _ai_answer(numbers: list[int]) -> dict:
    return {
        "questions": [
            {
                "number": n,
                "subject_key": "commercial",
                "topic": "ورشکستگی",
                "articles": [{"law": "ق.ت", "kind": "ماده", "number": "۴۱۲", "clause": ""}],
                "confidence": 0.9,
            }
            for n in numbers
        ]
    }


class FakeMessages:
    def __init__(self, reject_format: bool = False) -> None:
        self.calls: list[dict] = []
        self.reject_format = reject_format

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.reject_format and "format" in kwargs.get("output_config", {}):
            request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
            raise anthropic.BadRequestError(
                "output_config.format: unsupported",
                response=httpx.Response(400, request=request),
                body=None,
            )
        prompt = kwargs["messages"][0]["content"]
        numbers = [int(n) for n in re.findall(r'"number": (\d+)', prompt)]
        text = json.dumps(_ai_answer(numbers), ensure_ascii=False)
        if self.reject_format:
            text = "```json\n" + text + "\n```"
        return SimpleNamespace(
            stop_reason="end_turn", content=[SimpleNamespace(type="text", text=text)]
        )


def _questions(n: int) -> list[Question]:
    return [q(number=i, stem=f"سؤال {i} درباره‌ی تاجر") for i in range(1, n + 1)]


def test_ai_claude_batches_structured_output():
    messages = FakeMessages()
    questions = _questions(20)
    questions[0].classification.topic_source = "manual"
    questions[0].topic = "دستی"
    classify_with_ai(questions, "claude", Settings(), client=SimpleNamespace(messages=messages))
    assert len(messages.calls) == 2  # 15 + 5
    assert messages.calls[0]["output_config"]["format"]["type"] == "json_schema"
    last = questions[-1]
    assert last.subject_key == "commercial" and last.classification.subject_source == "ai"
    assert last.topic == "ورشکستگی" and last.classification.topic_source == "ai"
    assert [(a.law_key, a.number, a.source) for a in last.articles] == [
        ("commercial_code", "۴۱۲", "ai")
    ]
    assert questions[0].topic == "دستی"


def test_ai_claude_falls_back_to_prompted_json():
    messages = FakeMessages(reject_format=True)
    questions = _questions(2)
    classify_with_ai(questions, "claude", Settings(), client=SimpleNamespace(messages=messages))
    assert "format" not in messages.calls[-1]["output_config"]
    assert questions[1].topic == "ورشکستگی"


def test_ai_called_like_main_py(monkeypatch):
    messages = FakeMessages()
    monkeypatch.setattr(
        ai_classify.anthropic, "Anthropic", lambda **_: SimpleNamespace(messages=messages)
    )
    questions = _questions(1)
    classify_with_ai(questions, "claude", Settings(anthropic_api_key="test"))
    assert questions[0].subject_key == "commercial"
    with pytest.raises(AiEngineError):
        classify_with_ai(questions, "claude", Settings(anthropic_api_key=""))


def test_ai_gemini_and_errors():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["generationConfig"]["responseMimeType"] == "application/json"
        text = json.dumps(_ai_answer([1]), ensure_ascii=False)
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": text}]}}]})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    questions = _questions(1)
    classify_with_ai(questions, "gemini", Settings(gemini_api_key="k"), client=client)
    assert questions[0].topic == "ورشکستگی"

    failing = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    with pytest.raises(AiEngineError):
        classify_with_ai(_questions(1), "gemini", Settings(gemini_api_key="k"), client=failing)
    garbage = httpx.Client(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(
                200, json={"candidates": [{"content": {"parts": [{"text": "نه"}]}}]}
            )
        )
    )
    with pytest.raises(AiEngineError):
        classify_with_ai(_questions(1), "gemini", Settings(gemini_api_key="k"), client=garbage)


def test_rules_classification_called_like_main_py():
    questions = [q(number=1, stem="طبق ماده ۴۶۶ قانون مدنی اجاره چیست؟")]
    classify_project(questions, blueprint="auto", default_subject=None)
    assert questions[0].topic == "اجاره"
