from __future__ import annotations

import random
import time
from datetime import UTC, datetime

from app.duplicates import find_duplicates, question_fingerprint, similarity
from app.models import DuplicateRef, Flag, Option, Project, Question
from app.validate import is_clean, validate_question

STEM = "به موجب ماده ۱۹۰ قانون مدنی، کدام یک از موارد زیر از شرایط اساسی صحت معامله نیست؟"
OPTIONS = ["قصد طرفین و رضای آنها", "اهلیت طرفین", "موضوع معین که مورد معامله باشد", "قبض"]


def make_q(number: int = 1, stem: str = STEM, options=OPTIONS, **kw) -> Question:
    return Question(
        number=number,
        stem=stem,
        options=[Option(key=str(i), text=t) for i, t in enumerate(options, start=1)],
        **kw,
    )


def make_project(pid: str, questions: list[Question], title: str = "", mode="questions"):
    return Project(
        id=pid,
        title=title or pid,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        mode=mode,
        questions=questions,
    )


def test_fingerprint_ignores_ocr_variants_and_option_order():
    noisy = make_q(
        stem="۱۲- به موجب ماده 190 قانون مدني، كدام يک از موارد زير از شرايط اساسیِ صحت معامله نيست ?",
        options=[OPTIONS[3], OPTIONS[1], "الف) " + OPTIONS[0], OPTIONS[2]],
    )
    assert question_fingerprint(noisy) == question_fingerprint(make_q())
    assert similarity(noisy, make_q()) == 1.0


def test_similarity_scale():
    edited = make_q(stem=STEM.replace("کدام یک", "کدام‌یک"))
    assert similarity(edited, make_q()) > 0.95
    other = make_q(
        stem="در صورت فوت موکل، وکالت چه وضعیتی پیدا می‌کند؟",
        options=["منفسخ می‌شود", "باقی است", "غیرنافذ است", "باطل است"],
    )
    assert similarity(other, make_q()) < 0.4


def test_find_duplicates_within_and_across_projects():
    old = make_project("old", [make_q(7)], title="آزمون کانون ۱۴۰۳")
    text_mode = make_project("txt", [make_q(1)], mode="text")
    near = make_q(3, stem=STEM.replace("نیست؟", "نمی‌باشد؟"))
    unrelated = make_q(
        4,
        stem="مرور زمان در دعاوی حقوقی در حقوق فعلی ایران چه حکمی دارد؟",
        options=["پذیرفته نیست", "پذیرفته است", "فقط در اسناد تجاری", "فقط در امور کیفری"],
    )
    current = make_project("new", [make_q(1), near, unrelated])
    find_duplicates(current, [old, text_mode, current])
    q1, q3, q4 = current.questions
    assert [(d.project_id, d.number) for d in q1.duplicates] == [("old", 7), ("new", 3)]
    assert q1.duplicates[0].similarity == 1.0
    assert q1.duplicates[0].project_title == "آزمون کانون ۱۴۰۳"
    assert ("new", 1) in [(d.project_id, d.number) for d in q3.duplicates]
    assert q4.duplicates == []


def test_top_three_and_text_mode_project_skipped():
    others = [make_project(f"p{i}", [make_q(i)]) for i in range(5)]
    current = make_project("new", [make_q(1)])
    find_duplicates(current, others)
    assert len(current.questions[0].duplicates) == 3
    text_project = make_project("t", [make_q(1)], mode="text")
    find_duplicates(text_project, others)
    assert text_project.questions[0].duplicates == []


def test_duplicate_warning_message():
    q = make_q(
        duplicates=[
            DuplicateRef(project_id="o", project_title="آزمون ۱۴۰۲", number=12, similarity=0.953)
        ]
    )
    issue = next(i for i in validate_question(q, False) if i.code == "duplicate")
    assert issue.level == "warning"
    assert issue.message == "احتمالاً تکراری: سؤال ۱۲ پروژه‌ی «آزمون ۱۴۰۲» (۹۵٪)"


def _words(rng: random.Random, n: int) -> str:
    vocab = [
        "عقد",
        "بیع",
        "اجاره",
        "وکالت",
        "ضمان",
        "رهن",
        "صلح",
        "هبه",
        "وصیت",
        "ارث",
        "نکاح",
        "طلاق",
        "مهر",
        "نفقه",
        "حضانت",
        "ولایت",
        "قیم",
        "تاجر",
        "شرکت",
        "سهامی",
        "چک",
        "برات",
        "سفته",
        "ورشکستگی",
        "دلال",
        "قصاص",
        "دیه",
        "تعزیر",
        "سرقت",
        "کلاهبرداری",
        "جعل",
        "دادگاه",
        "دادسرا",
        "بازپرس",
        "قرار",
        "حکم",
        "تجدیدنظر",
        "فرجام",
        "اعاده",
        "دادرسی",
        "داوری",
        "ثبت",
        "سند",
        "ملک",
    ]
    return " ".join(rng.choice(vocab) for _ in range(n))


def _synthetic(rng: random.Random, number: int) -> Question:
    return make_q(
        number,
        stem=f"در خصوص {_words(rng, 14)} کدام گزینه صحیح است؟",
        options=[_words(rng, rng.randint(2, 7)) for _ in range(4)],
    )


def test_performance_5000_vs_140():
    rng = random.Random(7)
    existing = [
        make_project(f"p{k}", [_synthetic(rng, n) for n in range(1, 141)]) for k in range(36)
    ]  # 5,040 questions
    planted = existing[3].questions[10]
    new_questions = [_synthetic(rng, n) for n in range(1, 141)]
    new_questions[5] = make_q(6, stem=planted.stem, options=[o.text for o in planted.options])
    current = make_project("new", new_questions)
    start = time.perf_counter()
    find_duplicates(current, existing)
    elapsed = time.perf_counter() - start
    assert elapsed < 3.0, elapsed
    assert [(d.project_id, d.number) for d in current.questions[5].duplicates] == [("p3", 11)]
    assert sum(1 for q in current.questions if q.duplicates) == 1


# ------------------------------------------------------------------------ is_clean


def clean_q(**kw) -> Question:
    defaults = {
        "correct_key": "4",
        "key_source": "table",
        "subject_key": "civil",
        "topic": "شرایط اساسی صحت معامله",
        "explanation": "گزینه ۴ صحیح است.",
    }
    defaults.update(kw)
    return make_q(**defaults)


def test_is_clean_accepts_complete_question():
    assert is_clean(clean_q(), has_explanations=True)
    # allowed warnings: missing subject/topic, unknown law; missing explanation w/o file
    assert is_clean(clean_q(subject_key=None, topic="", explanation=""), has_explanations=False)


def test_is_clean_rejections():
    assert not is_clean(clean_q(stem=""), False)
    assert not is_clean(clean_q(options=OPTIONS[:3]), False)
    assert not is_clean(clean_q(options=[*OPTIONS[:3], ""]), False)
    assert not is_clean(clean_q(correct_key=None), False)
    assert not is_clean(clean_q(correct_key="5"), False)
    assert not is_clean(clean_q(explanation=""), True)  # explanations file but none found
    flag = Flag(field="stem", word="ماده", doc="booklet", page=0, reason="low_conf")
    assert not is_clean(clean_q(flags=[flag]), False)
    dup = DuplicateRef(project_id="o", number=1, similarity=0.9)
    assert not is_clean(clean_q(duplicates=[dup]), False)
    assert not is_clean(clean_q(explanation="گزینه «الف» صحیح است."), False)  # key_mismatch
    merged = clean_q(options=[*OPTIONS[:3], "قبض ۳) متن گزینه‌ی دیگر"])
    assert not is_clean(merged, False)
