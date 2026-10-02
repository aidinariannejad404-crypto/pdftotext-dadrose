from app.models import Flag, Option, Question
from app.validate import inline_key_statement, stated_key, validate_project, validate_question


def make_q(number: int = 1, **kw) -> Question:
    defaults = {
        "stem": "مطابق قانون مدنی، کدام عقد لازم است؟",
        "options": [
            Option(key="1", text="بیع"),
            Option(key="2", text="وکالت"),
            Option(key="3", text="عاریه"),
            Option(key="4", text="ودیعه"),
        ],
        "correct_key": "1",
        "key_source": "table",
        "subject_key": "civil",
        "topic": "قواعد عمومی قراردادها",
        "explanation": "گزینه ۱ صحیح است. بیع از عقود لازم است.",
    }
    defaults.update(kw)
    return Question(number=number, **defaults)


def codes(issues) -> list[str]:
    return [i.code for i in issues]


def test_clean_question_has_no_issues():
    assert validate_question(make_q(), has_explanations=True) == []


def test_empty_stem_and_option():
    q = make_q(stem=" ", options=[Option(key=k, text="" if k == "3" else "متن") for k in "1234"])
    issues = validate_question(q, False)
    assert "empty_stem" in codes(issues)
    empty = next(i for i in issues if i.code == "empty_option")
    assert empty.level == "error" and empty.field == "option:3"


def test_option_count_names_missing():
    q = make_q(options=[Option(key="1", text="الف"), Option(key="2", text="ب")])
    issue = next(i for i in validate_question(q, False) if i.code == "option_count")
    assert issue.level == "error"
    assert "۳، ۴" in issue.message


def test_missing_and_invalid_key():
    assert "missing_key" in codes(validate_question(make_q(correct_key=None), False))
    assert "invalid_key" in codes(validate_question(make_q(correct_key="5"), False))


def test_key_mismatch_between_table_and_explanation():
    q = make_q(correct_key="2", explanation="گزینه «الف» صحیح است.")
    issue = next(i for i in validate_question(q, True) if i.code == "key_mismatch")
    assert issue.level == "error" and "۲" in issue.message and "۱" in issue.message
    manual = make_q(correct_key="2", key_source="manual", explanation="گزینه ۱ صحیح است.")
    assert "key_mismatch" not in codes(validate_question(manual, True))


def test_missing_explanation_only_when_file_given():
    q = make_q(explanation="")
    assert "missing_explanation" in codes(validate_question(q, True))
    assert "missing_explanation" not in codes(validate_question(q, False))


def test_suspicious_words_count():
    flag = Flag(field="stem", word="لازم", doc="booklet", page=0, reason="low_conf")
    q = make_q(flags=[flag, flag.model_copy(update={"field": "option:2"})])
    issue = next(i for i in validate_question(q, False) if i.code == "suspicious_words")
    assert issue.message == "۲ کلمه مشکوک" and issue.level == "warning"


def test_merged_suspect_detection():
    swallowed = make_q(stem="کدام صحیح است؟ ۱) بیع ۲) اجاره")
    assert "merged_suspect" in codes(validate_question(swallowed, False))
    q = make_q(
        options=[
            Option(key="1", text="بیع"),
            Option(key="2", text="وکالت ۳) عاریه"),
            Option(key="3", text="عاریه"),
            Option(key="4", text="ودیعه"),
        ]
    )
    issue = next(i for i in validate_question(q, False) if i.code == "merged_suspect")
    assert issue.field == "option:2"
    long_opt = make_q(
        options=[Option(key=str(k), text="کوتاه") for k in range(1, 4)]
        + [Option(key="4", text="متن بسیار طولانی " * 20)]
    )
    assert "merged_suspect" in codes(validate_question(long_opt, False))
    # "ماده ۲-" and "بند ب)" inside a stem are references, not markers
    ok = make_q(stem="طبق ماده ۱) و بند ب) قانون، کدام صحیح است؟")
    assert "merged_suspect" not in codes(validate_question(ok, False))


def test_missing_subject_warning():
    issue = next(i for i in validate_question(make_q(subject_key=None), False))
    assert issue.code == "missing_subject" and issue.level == "warning"


def test_project_level_issues():
    qs = [make_q(n) for n in (1, 2, 2, 5)]
    qs[0].key_source = "explanation"
    issues = {i.code: i for i in validate_project(qs, False, 6)}
    assert "۳–۴، ۶" in issues["missing_numbers"].message
    assert "۲" in issues["duplicate_numbers"].message
    assert "count_mismatch" in issues
    assert "key_table_missing" not in issues


def test_key_table_missing():
    qs = [make_q(n, key_source="explanation") for n in (1, 2)]
    assert "key_table_missing" not in codes(validate_project(qs, True, None))  # all keyed
    qs[1].correct_key = None
    assert "key_table_missing" in codes(validate_project(qs, True, None))


def test_key_mismatch_inline_vs_table():
    q = make_q(correct_key="1", key_source="table", explanation="گزینه‌ی «د» درست است. زیرا ...")
    assert "key_mismatch" in codes(validate_question(q, False))
    inline = make_q(correct_key="4", key_source="inline", explanation="گزینه‌ی «د» درست است.")
    assert "key_mismatch" not in codes(validate_question(inline, False))
    # a later "... نادرست است" mention does not count as the stated key
    sub = make_q(
        correct_key="4",
        key_source="table",
        explanation="گزینه‌ی «الف» به این دلیل نادرست است که ... گزینه «د» درست است.",
    )
    assert "key_mismatch" not in codes(validate_question(sub, False))


def test_stated_key_variants():
    assert stated_key("گزینه ۳ صحیح است") == "3"
    assert stated_key("پاسخ: ۲ — طبق ماده ۱۰") == "2"
    assert stated_key("جواب صحیح گزینه «ج» است") == "3"
    assert stated_key("پاسخ صحیح گزینه چهارم است") == "4"
    assert stated_key("گزینه‌ی ۱ درست است") == "1"
    assert stated_key("طبق ماده ۱۲ قانون مدنی") is None


def test_inline_key_statement():
    assert inline_key_statement("گزینه‌ی «د» درست است. تعریف تاجر") == "4"
    assert inline_key_statement("گزینه «ب» صحیح است") == "2"
    assert inline_key_statement("پاسخ: گزینه ۴") == "4"
    assert inline_key_statement("جواب: ج") == "3"
    assert inline_key_statement("گزینه‌ی «الف» به این دلیل نادرست است") is None
    assert inline_key_statement("گزینه «ب» درست نیست") is None
    assert inline_key_statement("طبق ماده ۲ گزینه ۳ درست است") is None
