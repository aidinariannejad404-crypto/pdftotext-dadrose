from __future__ import annotations

import re

from app.models import DocumentResult, Line, PageResult, Word
from app.parser import (
    build_questions,
    detect_mode,
    document_plain_text,
    page_plain_text,
    parse_single_question,
)

PAGE_BREAK = "---page---"
_FLAG = re.compile(r"^(.*)\{(\?|!([^}]*))\}$")


def make_lines(text: str, page: int = 0) -> list[Line]:
    """One Line per non-empty row; fake RTL bboxes. `word{?}` = low_conf, `word{!alt}` = disagree."""
    lines: list[Line] = []
    for row in [r for r in text.strip().splitlines() if r.strip()]:
        y0 = 0.04 + len(lines) * 0.03
        words: list[Word] = []
        for j, raw in enumerate(row.split()):
            x1 = 0.95 - j * 0.05
            bbox = (round(x1 - 0.045, 3), y0, round(x1, 3), y0 + 0.025)
            m = _FLAG.match(raw)
            if m:
                disagree = m.group(2).startswith("!")
                words.append(
                    Word(
                        text=m.group(1),
                        bbox=bbox,
                        flag="disagree" if disagree else "low_conf",
                        alt=m.group(3) if disagree else None,
                        conf=40.0,
                    )
                )
            else:
                words.append(Word(text=raw, bbox=bbox, conf=95.0))
        lines.append(Line(page=page, words=words))
    return lines


def make_doc(text: str, kind: str = "booklet") -> DocumentResult:
    pages = []
    for index, chunk in enumerate(text.split(PAGE_BREAK)):
        pages.append(
            PageResult(
                index=index,
                width=1000,
                height=1400,
                source="ocr",
                engine="test",
                lines=make_lines(chunk, index),
            )
        )
    return DocumentResult(kind=kind, filename=f"{kind}.pdf", pages=pages)  # type: ignore[arg-type]


def parse(text: str, explanations: str | None = None, blueprint: str = "auto"):
    expl = make_doc(explanations, "explanations") if explanations else None
    return build_questions(make_doc(text), expl, blueprint)


def by_number(result):
    return {q.number: q for q in result.questions}


def opts(q) -> list[str]:
    return [o.text for o in q.options]


def codes(issues) -> set[str]:
    return {i.code for i in issues}


# ---------------------------------------------------------------- typed booklet

TYPED = """
آزمون ورودی کارآموزی کانون وکلای دادگستری ۱۴۰۵
۱- در کدام مورد عقد بیع باطل است؟
۱) بیع مال غیر بدون اجازه مالک
۲) بیع مال مرهونه بدون اذن مرتهن
۳) بیع مجهول‌المقدار
۴) بیع فضولی
۲- مطابق ماده ۱۰ قانون مدنی، قراردادهای خصوصی نسبت به کسانی که آن را منعقد نموده‌اند:
۱) در صورتی که مخالف صریح قانون نباشد نافذ است
۲) مطلقاً نافذ است
۳) غیرنافذ است
۴) باطل است
۳- حق انتفاع از مال موقوفه کدام است؟
۱) عمری ۲) رقبی ۳) سکنی ۴) حبس مطلق
"""


def test_typed_booklet_one_option_per_line_and_inline():
    result = parse(TYPED)
    qs = by_number(result)
    assert sorted(qs) == [1, 2, 3]
    assert qs[1].stem == "در کدام مورد عقد بیع باطل است؟"
    assert opts(qs[1])[0] == "بیع مال غیر بدون اجازه مالک"
    assert qs[2].stem.startswith("مطابق ماده ۱۰ قانون مدنی")
    assert opts(qs[2])[3] == "باطل است"
    assert opts(qs[3]) == ["عمری", "رقبی", "سکنی", "حبس مطلق"]
    for q in qs.values():
        assert [o.key for o in q.options] == ["1", "2", "3", "4"]
        assert q.regions and q.regions[0].doc == "booklet"


def test_letter_markers_and_wrapped_options():
    text = """
۱۲- کدام گزینه در خصوص اقاله صحیح است؟
الف) اقاله در عقود جایز
نیز جریان دارد و اثر آن از زمان انعقاد عقد است
ب) اقاله در نکاح جاری نیست
ج) اقاله عقدی جایز است
د) اقاله در وقف نیز
جاری است
۱۳- شرط خلاف مقتضای ذات عقد:
الف) باطل و مبطل عقد است ب) فقط باطل است ج) صحیح است د) موجب خیار است
"""
    qs = by_number(parse(text))
    assert sorted(qs) == [12, 13]
    assert opts(qs[12])[0] == "اقاله در عقود جایز نیز جریان دارد و اثر آن از زمان انعقاد عقد است"
    assert opts(qs[12])[3] == "اقاله در وقف نیز جاری است"
    assert opts(qs[13]) == ["باطل و مبطل عقد است", "فقط باطل است", "صحیح است", "موجب خیار است"]


def test_stem_items_with_letters_and_digit_options():
    text = """
۵- کدام موارد از شرایط اساسی صحت معامله است؟
الف) قصد طرفین و رضای آنها ب) اهلیت طرفین
ج) موضوع معین د) مشروعیت جهت معامله
۱) الف و ب ۲) الف، ب و ج
۳) همه موارد ۴) ب و د
۶- متن سؤال بعدی؟
۱) یک ۲) دو ۳) سه ۴) چهار
"""
    qs = by_number(parse(text))
    assert "الف) قصد طرفین" in qs[5].stem and "د) مشروعیت جهت معامله" in qs[5].stem
    assert opts(qs[5]) == ["الف و ب", "الف، ب و ج", "همه موارد", "ب و د"]
    assert len(qs[6].options) == 4


def test_numbers_inside_stem_and_options_are_not_markers():
    text = """
۸- به موجب ماده ۱- قانون آیین دادرسی مدنی و تبصره ۲- ماده ۳۴۸، کدام صحیح است؟
۱) طبق بند ب) ماده ۱۰ دعوا قابل استماع است
۲) مدت ۲-۳ سال است
۳) ماده ۱۰ قانون مدنی
۴) هیچکدام
۹- سؤال نهم؟
۱) الف ۲) ب ۳) ج ۴) د
"""
    qs = by_number(parse(text))
    assert sorted(qs) == [8, 9]
    assert "ماده ۱- قانون" in qs[8].stem and "تبصره ۲- ماده ۳۴۸" in qs[8].stem
    assert opts(qs[8])[0] == "طبق بند ب) ماده ۱۰ دعوا قابل استماع است"
    assert opts(qs[8])[1] == "مدت ۲-۳ سال است"


def test_page_break_continuation_and_headers_removed():
    header = "آزمون وکالت مرکز وکلا ۱۴۰۴ - دفترچه شماره ۱"
    text = f"""
{header}
۱- مطابق قانون تجارت، شرکت سهامی خاص با چند نفر
۱) دو نفر ۲) سه نفر ۳) پنج نفر ۴) هفت نفر
۲- در شرکت با مسئولیت محدود، سرمایه
صفحه ۱
{PAGE_BREAK}
{header}
باید تماماً نقداً پرداخت شود؟
۱) بله در همه حال
۲) خیر فقط غیرنقدی
Scanned with CamScanner
{PAGE_BREAK}
{header}
۳) ممکن است
۴) فقط در زمان تأسیس
- ۳ -
"""
    qs = by_number(parse(text))
    assert sorted(qs) == [1, 2]
    assert qs[2].stem == "در شرکت با مسئولیت محدود، سرمایه باید تماماً نقداً پرداخت شود؟"
    assert opts(qs[2]) == ["بله در همه حال", "خیر فقط غیرنقدی", "ممکن است", "فقط در زمان تأسیس"]
    assert {r.page for r in qs[2].regions} == {0, 1, 2}
    assert "CamScanner" not in " ".join(opts(qs[2]))


def test_noisy_ocr_variants():
    text = """
1٢- كدام مورد صحيح است?
۱)مالكيت مطلق است
۲ ) مالكيت نسبي است
(۳ مالکیت زمانی باطل است
-۴ هيچكدام
۱۳ - در قتل عمد مجازات چيست ؟
١) قصاص ٢) ديه ٣) تعزير ٤) حبس
-۱۴ ســؤال تست با کشیده
۱) الف ۲) ب ۳) ج ۴) د
"""
    qs = by_number(parse(text))
    assert sorted(qs) == [12, 13, 14]
    assert qs[12].stem == "کدام مورد صحیح است؟"
    assert opts(qs[12]) == [
        "مالکیت مطلق است",
        "مالکیت نسبی است",
        "مالکیت زمانی باطل است",
        "هیچکدام",
    ]
    assert qs[13].stem == "در قتل عمد مجازات چیست؟"
    assert opts(qs[13]) == ["قصاص", "دیه", "تعزیر", "حبس"]
    assert qs[14].stem == "سؤال تست با کشیده"


def test_question_number_on_its_own_line_and_split_delimiter():
    text = """
۱۹- سؤال نوزدهم؟
۱) الف ۲) ب ۳) ج ۴) د
۲۰ -
مرور زمان در دعاوی حقوقی:
۱) پذیرفته نیست ۲) پذیرفته است
۳) فقط در اسناد تجاری ۴) فقط در کیفری
۲۱
اقرار در امور کیفری؟
۱) یک بار کافی است
۲) دو بار لازم است ۳) چهار بار ۴) بستگی دارد
"""
    qs = by_number(parse(text))
    assert sorted(qs) == [19, 20, 21]
    assert qs[20].stem == "مرور زمان در دعاوی حقوقی:"
    assert qs[21].stem == "اقرار در امور کیفری؟"
    assert opts(qs[21])[1] == "دو بار لازم است"


def test_gaps_reported_and_instructions_before_first_question():
    text = """
توجه:
۱- مدت پاسخگویی ۱۷۰ دقیقه است.
۲- پاسخ غلط نمره منفی دارد.
۱- سؤال اول؟
۱) الف ۲) ب ۳) ج ۴) د
۲- سؤال دوم؟
۱) الف ۲) ب ۳) ج ۴) د
۵- سؤال پنجم؟
۱) الف ۲) ب ۳) ج ۴) د
"""
    result = parse(text)
    qs = by_number(result)
    assert sorted(qs) == [1, 2, 5]
    assert qs[1].stem == "سؤال اول؟"
    missing = next(i for i in result.issues if i.code == "missing_numbers")
    assert "۳–۴" in missing.message


def test_question_vs_option_style_tiebreak():
    # Questions use "N." and options "N)": "۳." after two options must start question 3.
    text = """
۱. سؤال اول؟
۱) الف ۲) ب ۳) ج ۴) د
۲. سؤال دوم با گزینه‌های ناقص؟
۱) الف ۲) ب
۳. سؤال سوم؟
۱) الف ۲) ب ۳) ج ۴) د
۴. چهارم؟
۱) الف ۲) ب ۳) ج ۴) د
۵. پنجم؟
۱) الف ۲) ب ۳) ج ۴) د
۶. ششم؟
۱) الف ۲) ب ۳) ج ۴) د
"""
    qs = by_number(parse(text))
    assert sorted(qs) == [1, 2, 3, 4, 5, 6]
    assert len(qs[2].options) == 2
    assert "option_count" in codes(qs[2].issues)
    assert qs[3].stem == "سؤال سوم؟"


# -------------------------------------------------------------------- key table

FOUR_Q = """
۱- سؤال اول درباره عقد بیع؟
۱) الف ۲) ب ۳) ج ۴) د
۲- سؤال دوم درباره اجاره؟
۱) الف ۲) ب ۳) ج ۴) د
۳- سؤال سوم درباره رهن؟
۱) الف ۲) ب ۳) ج ۴) د
۴- سؤال چهارم درباره صلح؟
۱) الف ۲) ب ۳) ج ۴) د
"""


def keys(result) -> dict[int, str | None]:
    return {q.number: q.correct_key for q in result.questions}


def test_key_table_pairs():
    text = FOUR_Q + f"{PAGE_BREAK}\nکلید سؤالات\n۱-۳ ۲-۱\n۳ : ۴\n۴. ب\n"
    result = parse(text)
    assert keys(result) == {1: "3", 2: "1", 3: "4", 4: "2"}
    assert all(q.key_source == "table" for q in result.questions)
    assert len(by_number(result)[4].options) == 4  # key lines not merged into Q4
    assert "key_table_missing" not in codes(result.issues)


def test_key_table_pipe_rows():
    text = FOUR_Q + "\nپاسخنامه\n| سؤال | پاسخ |\n| ۱ | ۲ |\n| ۲ | ۴ |\n| ۳ | ۱ |\n| ۴ | ۳ |\n"
    assert keys(parse(text)) == {1: "2", 2: "4", 3: "1", 4: "3"}


def test_key_table_grid_and_letters():
    text = FOUR_Q + "\nپاسخ‌نامه\n۱ ۲ ۳ ۴\nج الف د ب\n"
    assert keys(parse(text)) == {1: "3", 2: "1", 3: "4", 4: "2"}


def test_key_table_wide_alternating_row():
    text = FOUR_Q + "\nکلید\n| ۱ | ۴ | ۲ | ۴ |\n| ۳ | ۲ | ۴ | ۱ |\n"
    assert keys(parse(text)) == {1: "4", 2: "4", 3: "2", 4: "1"}


def test_key_missing_reported():
    result = parse(FOUR_Q)
    assert "key_table_missing" in codes(result.issues)
    assert all("missing_key" in codes(q.issues) for q in result.questions)


# ----------------------------------------------------------------- explanations

EXPLANATIONS = """
پاسخ تشریحی آزمون
۱- گزینه ۳ صحیح است. طبق ماده ۳۴۸ قانون مدنی:
۱- بیع چیزی که خرید و فروش آن قانوناً ممنوع است باطل است.
۲- بیع چیزی که مالیت ندارد باطل است.
۳- بیع مجهول باطل است.
۲- گزینه «الف» صحیح است. ماده ۴۶۸ ق.م
سؤال ۳: پاسخ: ۲
با توجه به ماده ۷۷۱ قانون مدنی رهن عقدی است که
به موجب آن مدیون مالی را برای وثیقه به داین می‌دهد.
۴- جواب صحیح گزینه ۴ است زیرا صلح{?} عقدی مستقل است.
"""


def test_explanations_with_numbered_sublists():
    text = FOUR_Q + "\nکلید سؤالات\n۱-۳ ۲-۲ ۳-۲ ۴-۴\n"
    result = parse(text, EXPLANATIONS)
    qs = by_number(result)
    assert qs[1].explanation.startswith("گزینه ۳ صحیح است")
    assert "۳- بیع مجهول باطل است." in qs[1].explanation
    assert "\n" in qs[1].explanation  # sub-list kept as paragraphs
    assert qs[2].explanation.startswith("گزینه «الف»")
    assert qs[3].explanation.startswith("پاسخ: ۲ با توجه به ماده ۷۷۱")
    assert any(r.doc == "explanations" for r in qs[3].regions)
    # Q2: table says 2, explanation says الف (1) -> mismatch
    assert "key_mismatch" in codes(qs[2].issues)
    assert "key_mismatch" not in codes(qs[1].issues)
    flag = next(f for f in qs[4].flags if f.field == "explanation")
    assert flag.word == "صلح" and flag.doc == "explanations"


def test_key_from_explanation_when_no_table():
    result = parse(FOUR_Q, EXPLANATIONS)
    qs = by_number(result)
    assert qs[1].correct_key == "3" and qs[1].key_source == "explanation"
    assert qs[2].correct_key == "1"
    assert qs[3].correct_key == "2"
    assert qs[4].correct_key == "4"


def test_missing_explanation_warning():
    expl = "۱- گزینه ۱ صحیح است.\n۳- گزینه ۲ صحیح است.\n"
    qs = by_number(parse(FOUR_Q, expl))
    assert "missing_explanation" in codes(qs[2].issues)
    assert "missing_explanation" not in codes(qs[1].issues)


# --------------------------------------------------------------------- subjects


def test_subject_from_bar_blueprint_ranges():
    text = "\n".join(f"{n}- سؤال شماره {n}؟\n۱) الف ۲) ب ۳) ج ۴) د" for n in (19, 20, 21, 22))
    result = parse(text, blueprint="BAR-1405")
    qs = by_number(result)
    assert qs[19].subject_key == "civil" and qs[20].subject_key == "civil"
    assert qs[21].subject_key == "civil_procedure"
    assert "count_mismatch" in codes(result.issues)


def test_subject_from_headings_auto():
    text = """
حقوق مدنی
۱- سؤال مدنی؟
۱) الف ۲) ب ۳) ج ۴) د
۲- سؤال مدنی دوم؟
۱) الف ۲) ب ۳) ج ۴) د
بخش دوم: آیین دادرسی مدنی (سؤالات ۳ تا ۴)
۳- سؤال آیین دادرسی؟
۱) الف ۲) ب ۳) ج ۴) د
۴- سؤال دیگر؟
۱) الف ۲) ب ۳) ج ۴) د
"""
    qs = by_number(parse(text))
    assert [qs[n].subject_key for n in (1, 2, 3, 4)] == [
        "civil",
        "civil",
        "civil_procedure",
        "civil_procedure",
    ]
    assert "آیین" not in opts(qs[2])[3]
    assert "missing_subject" not in codes(qs[1].issues)


# ------------------------------------------------------------------------ flags


def test_flags_land_in_correct_field():
    text = """
۷- حکم{?} معامله صغیر ممیز چیست؟
۱) باطل ۲) غیرنافذ{!غیرنافد} ۳) صحیح
۴) قابل{?}
فسخ
"""
    q = by_number(parse(text))[7]
    by_field = {f.field: f for f in q.flags}
    assert by_field["stem"].word == "حکم" and by_field["stem"].reason == "low_conf"
    assert by_field["option:2"].reason == "disagree" and by_field["option:2"].alt == "غیرنافد"
    assert by_field["option:4"].word == "قابل"
    assert by_field["option:2"].bbox is not None and by_field["option:2"].doc == "booklet"
    assert opts(q)[3] == "قابل فسخ"
    assert "suspicious_words" in codes(q.issues)


def test_flag_on_glued_marker_word_goes_to_option():
    text = "۱- سؤال؟\n۱)باطل{?} ۲) صحیح ۳) غیرنافذ ۴) نافذ\n"
    q = by_number(parse(text))[1]
    assert [f.field for f in q.flags] == ["option:1"]
    assert opts(q)[0] == "باطل"


# ---------------------------------------------------------- parse_single_question


def test_parse_single_question_booklet():
    lines = make_lines(
        """
۴۲- در دعوای{?} تصرف عدوانی
کدام صحیح است؟
۱) مالکیت شرط است ۲) سبق تصرف کافی است
۳) فقط در اموال غیرمنقول ۴) گزینه ۲ و ۳
""",
        page=5,
    )
    q = parse_single_question(lines, "booklet")
    assert q is not None
    assert q.number == 42
    assert q.stem == "در دعوای تصرف عدوانی کدام صحیح است؟"
    assert opts(q)[3] == "گزینه ۲ و ۳"
    assert q.flags[0].page == 5 and q.flags[0].field == "stem"
    assert q.regions[0].page == 5


def test_parse_single_question_without_number():
    lines = make_lines("صورت سؤال بدون شماره\n۱) الف ۲) ب\n۳) ج ۴) د")
    q = parse_single_question(lines, "booklet")
    assert q is not None and q.number == 0
    assert q.stem == "صورت سؤال بدون شماره"
    assert opts(q) == ["الف", "ب", "ج", "د"]


def test_parse_single_question_explanation():
    lines = make_lines("۱۲- گزینه ۲ صحیح است.\nطبق ماده ۱۰ قانون مدنی")
    q = parse_single_question(lines, "explanations")
    assert q is not None and q.number == 12
    assert q.explanation == "گزینه ۲ صحیح است. طبق ماده ۱۰ قانون مدنی"
    assert q.correct_key == "2"


def test_parse_single_question_empty():
    assert parse_single_question([], "booklet") is None


def test_key_table_labelled_grid_and_reversed_rtl_grid():
    labelled = (
        FOUR_Q
        + "\nکلید سؤالات\n| سؤال | ۱ | ۲ |\n| پاسخ | ۴ | ۲ |\n| سؤال | ۳ | ۴ |\n| پاسخ | ۱ | ج |\n"
    )
    assert keys(parse(labelled)) == {1: "4", 2: "2", 3: "1", 4: "3"}
    rtl = FOUR_Q + "\nپاسخنامه\n۴ ۳ ۲ ۱\nالف د ج ب\n"
    assert keys(parse(rtl)) == {4: "1", 3: "4", 2: "3", 1: "2"}


def test_full_booklet_ai_markdown_with_key_grid():
    body = "\n".join(
        f"**{n}.** به موجب ماده {n + 3}- قانون مدنی کدام صحیح است؟\n"
        f"۱) حکم اول {n} ۲) حکم دوم\n۳) حکم سوم\n۴) حکم چهارم"
        for n in range(1, 141)
    )
    rows = []
    for r in range(0, 140, 10):
        rows.append(" ".join(str(n) for n in range(r + 1, r + 11)))
        rows.append(" ".join(str(n % 4 + 1) for n in range(r + 1, r + 11)))
    result = parse(body + PAGE_BREAK + "\nکلید سؤالات\n" + "\n".join(rows), blueprint="BAR-1405")
    qs = by_number(result)
    assert sorted(qs) == list(range(1, 141))
    assert codes(result.issues) == set()
    assert all(len(q.options) == 4 and q.correct_key == str(q.number % 4 + 1) for q in qs.values())
    assert qs[17].stem == "به موجب ماده 20- قانون مدنی کدام صحیح است؟"
    assert qs[75].subject_key == "fiqh_bar" and qs[140].subject_key == "constitutional"
    assert opts(qs[140]) == ["حکم اول 140", "حکم دوم", "حکم سوم", "حکم چهارم"]


def test_same_marker_style_for_questions_and_options():
    text = "\n".join(f"{n}- سؤال {n}؟\n۱- الف\n۲- ب\n۳- ج\n۴- د" for n in range(1, 8))
    qs = by_number(parse(text))
    assert sorted(qs) == list(range(1, 8))
    assert all(opts(q) == ["الف", "ب", "ج", "د"] for q in qs.values())


def test_explanations_with_prefix_and_repeated_question_text():
    expl = """
پاسخ سؤال ۱
۱- سؤال اول درباره عقد بیع؟ ۱) الف ۲) ب ۳) ج ۴) د
پاسخ: گزینه ۳ زیرا طبق ماده ۳۴۸ قانون مدنی...
پاسخ سؤال ۲
توضیح بدون ذکر کلید
پاسخ سوال ۴
گزینه ۲ صحیح است.
"""
    qs = by_number(parse(FOUR_Q, expl))
    assert qs[1].correct_key == "3" and qs[1].key_source == "explanation"
    assert qs[2].explanation == "توضیح بدون ذکر کلید" and qs[2].correct_key is None
    assert qs[3].explanation == ""
    assert qs[4].correct_key == "2"


def test_numbered_items_in_first_stem_with_question_style():
    text = """
۱- کدام یک از موارد زیر از اسباب سقوط تعهدات است؟
۱- اقاله
۲- ابراء
۳- تبدیل تعهد
۱) فقط ۱ ۲) ۱ و ۲ ۳) همه موارد ۴) هیچکدام
۲- سؤال دوم؟
۱) الف ۲) ب ۳) ج ۴) د
۳- سؤال سوم؟
۱) الف ۲) ب ۳) ج ۴) د
۵- پنجم؟
۱) الف ۲) ب ۳) ج ۴) د
۶- ششم؟
۱) الف ۲) ب ۳) ج ۴) د
"""
    qs = by_number(parse(text))
    assert sorted(qs) == [1, 2, 3, 5, 6]
    assert qs[1].stem == (
        "کدام یک از موارد زیر از اسباب سقوط تعهدات است؟ ۱- اقاله ۲- ابراء ۳- تبدیل تعهد"
    )
    assert opts(qs[1]) == ["فقط ۱", "۱ و ۲", "همه موارد", "هیچکدام"]
    assert qs[2].stem == "سؤال دوم؟"


def test_lost_options_and_option_style_variant():
    base = "\n".join(f"{n}- سؤال {n}؟\n۱) الف ۲) ب ۳) ج ۴) د" for n in range(1, 7))
    text = (
        base
        + "\n۷- سؤال هفتم که گزینه‌هایش خوانده نشد"
        + "\n۸- سؤال هشتم؟\n۱- یک\n۲- دو\n۳- سه\n۴- چهار"
        + "\n۹- نهم؟\n۱) الف ۲) ب ۳) ج ۴) د"
    )
    qs = by_number(parse(text))
    assert sorted(qs) == list(range(1, 10))
    assert qs[7].options == [] and "option_count" in codes(qs[7].issues)
    assert opts(qs[8]) == ["یک", "دو", "سه", "چهار"]
    assert opts(qs[9]) == ["الف", "ب", "ج", "د"]


# ------------------------------------------------------------ test-book layout
# Commercial test books: running headers, source tags, letter options (often two per
# line, OCR-damaged markers) and an inline explanation right after each question.

TEST_BOOK = f"""
۱۴ نشر نمونه / مجموعه پرسش‌های چهارگزینه‌ای حقوق مدنی
بخش نخست: کلیات قراردادها
فصل نخست: شرایط اساسی صحت معامله
۱- کدام یک از موارد زیر از شرایط اساسی صحت معامله نیست؟ (ارشد سراسری-۸۸)
الف) قصد و رضا ب) اهلیت
ج( موضوع معین د) قبض
گزینه‌ی «د» درست است. طبق ماده‌ی ۱۹۰ قانون مدنی شرایط اساسی صحت معامله
چهار مورد است و قبض در آن ذکر نشده است.
گزینه‌ی «الف» به این دلیل نادرست است که قصد و رضا شرط صحت است.
۲- معامله‌ی شخص سفیه در امور مالی:
(وکالت -۸۷)
لف) باطل است
ب ) غیرنافذ است
ج‌( صحیح{{?}} است
د)قابل فسخ است
گزینه ۲ درست است. مطابق ماده‌ی ۲۱۲ قانون مدنی معامله با سفیه
{PAGE_BREAK}
بخش نخست: کلیات قراردادها ۱۵
بدون اذن ولی یا قیم نافذ نیست. نکات زیر قابل توجه است:
۱- اذن لاحق ولی معامله را تنفیذ می‌کند.
۲- رد ولی معامله را باطل{{!باطلی}} می‌کند.
۳- ثالث با حسن نیت در این مورد حمایت نمی‌شود.
۳- در کدام مورد عقد باطل است؟ (قضاوت ۱۴۰۰)
الف) اکراه ب) اشتباه در شخص طرف در عقودی که شخصیت علت عمده نیست
ج) اشتباه در خود موضوع معامله د) غبن فاحش
پاسخ: گزینه ۳
اشتباه در خود موضوع معامله موجب بطلان است.
"""


def test_test_book_layout():
    result = parse(TEST_BOOK)
    qs = by_number(result)
    assert sorted(qs) == [1, 2, 3]

    q1 = qs[1]
    assert q1.stem == "کدام یک از موارد زیر از شرایط اساسی صحت معامله نیست؟"
    assert q1.source_ref == "ارشد سراسری-۸۸"
    assert opts(q1) == ["قصد و رضا", "اهلیت", "موضوع معین", "قبض"]
    assert q1.correct_key == "4" and q1.key_source == "inline"
    assert q1.explanation.startswith("گزینه‌ی «د» درست است. طبق ماده‌ی ۱۹۰")
    assert "به این دلیل نادرست است" in q1.explanation  # sub-mention kept, key unchanged

    q2 = qs[2]
    assert q2.stem == "معامله‌ی شخص سفیه در امور مالی:"
    assert q2.source_ref == "وکالت-۸۷"
    assert opts(q2) == ["باطل است", "غیرنافذ است", "صحیح است", "قابل فسخ است"]
    assert q2.correct_key == "2"
    # the explanation continues across the page break; the running header is dropped
    assert "معامله با سفیه بدون اذن ولی یا قیم نافذ نیست." in q2.explanation
    assert "کلیات قراردادها" not in q2.explanation
    assert "۳- ثالث با حسن نیت" in q2.explanation  # numbered list, not question 3
    fields = {f.field for f in q2.flags}
    assert fields == {"option:3", "explanation"}
    assert all(f.doc == "booklet" for f in q2.flags)
    assert {r.page for r in q2.regions} == {0, 1}

    q3 = qs[3]
    assert q3.source_ref == "قضاوت ۱۴۰۰"
    assert opts(q3)[1] == "اشتباه در شخص طرف در عقودی که شخصیت علت عمده نیست"
    assert q3.correct_key == "3" and q3.explanation.startswith("پاسخ: گزینه ۳")

    assert all(i.level != "error" for q in qs.values() for i in q.issues)
    assert "key_table_missing" not in codes(result.issues)
    assert detect_mode(result) == "questions"


def _glitch_doc(same_row: bool) -> DocumentResult:
    text = """
۴- انتقال دین بدون رضایت طلبکار:
الف) صحیح است ب) باطل است
ج) غیرنافذ است د) قابل فسخ است
مقرر شده است و نیازی به تشریفات خاص نیست.
(کانون ۹۸)
گزینه‌ی «ج» درست است. حکم این مسئله در ماده‌ی ۲۹۲ قانون مدنی
۵- سؤال بعدی؟
الف) یک ب) دو ج) سه د) چهار
"""
    doc = make_doc(text)
    lines = doc.pages[0].lines
    statement = lines[5]
    y0, y1 = statement.words[0].bbox[1], statement.words[0].bbox[3]
    statement.bbox = (0.5, y0, 0.95, y1)
    glitch_y = (y0, y1) if same_row else (lines[3].words[0].bbox[1], lines[3].words[0].bbox[3])
    lines[3].bbox = (0.05, glitch_y[0], 0.48, glitch_y[1])
    lines[4].bbox = (0.05, 0.3, 0.2, 0.32)  # source tag, OCR'd far from its stem
    return doc


def test_line_order_glitch_goes_to_explanation():
    for same_row in (True, False):
        q = by_number(build_questions(_glitch_doc(same_row), None, "auto"))[4]
        assert opts(q)[3] == "قابل فسخ است"
        assert q.source_ref == "کانون ۹۸"
        assert q.correct_key == "3"
        assert q.explanation == (
            "گزینه‌ی «ج» درست است. حکم این مسئله در ماده‌ی ۲۹۲ قانون مدنی "
            "مقرر شده است و نیازی به تشریفات خاص نیست."
        )


def test_table_key_wins_over_inline_and_mismatch_reported():
    text = TEST_BOOK + "\nکلید سؤالات\n۱-۴ ۲-۱ ۳-۳\n"
    qs = by_number(parse(text))
    assert qs[1].key_source == "table" and "key_mismatch" not in codes(qs[1].issues)
    assert qs[2].correct_key == "1" and "key_mismatch" in codes(qs[2].issues)


# ---------------------------------------------------------- notes bank / full text

NOTES_BANK = """
بانک نکات حقوق مدنی
فصل اول: قواعد عمومی قراردادها
نکته ۱: عقد بیع از عقود تملیکی و معوض است و با ایجاب و قبول طرفین
واقع می‌شود.
نکته ۲: در بیع مال غیر، معامله غیرنافذ است و با اجازه مالک تنفیذ می‌شود.
• شرط ضمن عقد تابع عقد اصلی است و با انحلال عقد منحل می‌شود.
• اقاله در همه عقود لازم به جز نکاح جاری است.
۱- عقد جایز با فوت یا حجر هر یک از طرفین منحل می‌شود.
۲- وکالت از عقود جایز است مگر آنکه ضمن عقد لازم دیگری به نحو صریح شرط
شده باشد.
"""


def test_notes_bank_is_text_mode_and_keeps_structure():
    result = parse(NOTES_BANK)
    assert detect_mode(result) == "text"
    page = make_doc(NOTES_BANK).pages[0]
    lines = page_plain_text(page).split("\n")
    assert "فصل اول: قواعد عمومی قراردادها" in lines
    assert "نکته ۱: عقد بیع از عقود تملیکی و معوض است و با ایجاب و قبول طرفین واقع می‌شود." in lines
    assert "• اقاله در همه عقود لازم به جز نکاح جاری است." in lines
    assert (
        "۲- وکالت از عقود جایز است مگر آنکه ضمن عقد لازم دیگری به نحو صریح شرط شده باشد." in lines
    )
    assert len(lines) == 8


def test_document_plain_text_drops_running_headers():
    pages = document_plain_text(make_doc(TEST_BOOK))
    assert len(pages) == 2
    assert "نشر نمونه" not in pages[0]
    assert pages[0].split("\n")[0] == "بخش نخست: کلیات قراردادها"
    assert pages[1].startswith("بدون اذن ولی یا قیم نافذ نیست.")
    assert "\nالف) اکراه ب) اشتباه" in pages[1]


def test_detect_mode_for_official_booklet():
    assert detect_mode(parse(FOUR_Q)) == "questions"
