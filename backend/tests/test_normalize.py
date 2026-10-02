from app.normalize import comparable, normalize_text, to_ascii_digits, to_persian_digits

ZWNJ = chr(0x200C)
ZWSP = chr(0x200B)
BOM = chr(0xFEFF)


def test_arabic_letters_and_digits_become_persian():
    assert normalize_text("كتاب علي ٣٤ صفحه") == "کتاب علی ۳۴ صفحه"
    assert normalize_text("موسى") == "موسی"


def test_presentation_forms_nfkc():
    assert normalize_text("ﻻ") == "لا"  # ligature lam-alef


def test_tatweel_removed_only_between_letters():
    assert normalize_text("قانــــون مدنـی") == "قانون مدنی"
    assert normalize_text("۱ـ متن") == "۱ـ متن"  # used as a delimiter after a digit


def test_zwnj_cleanup():
    assert normalize_text(f"کتاب{ZWNJ}{ZWNJ}ها") == f"کتاب{ZWNJ}ها"
    assert normalize_text(f"خانه {ZWNJ}ای") == "خانه ای"
    assert normalize_text(f"{ZWNJ}سلام{ZWNJ}") == "سلام"
    assert normalize_text("حق" + ZWSP + "وق" + BOM) == "حقوق"


def test_mi_prefix_gets_zwnj():
    assert normalize_text("حکم صادر می شود و نمی توان") == f"حکم صادر می{ZWNJ}شود و نمی{ZWNJ}توان"
    assert normalize_text("کمی دیر") == "کمی دیر"  # not a prefix


def test_question_mark_and_spacing():
    assert normalize_text("کدام صحیح است ?") == "کدام صحیح است؟"
    assert normalize_text("What ?") == "What ?"
    assert normalize_text("الف ، ب") == "الف، ب"


def test_whitespace_and_paragraphs():
    assert normalize_text("  الف \t  ب  ") == "الف ب"
    assert normalize_text("بند اول\n\n  بند دوم") == "بند اول\nبند دوم"
    assert normalize_text("") == ""


def test_digit_conversions():
    assert to_ascii_digits("۱۲-٣") == "12-3"
    assert to_persian_digits("12 و ٣") == "۱۲ و ۳"
    assert to_persian_digits(140) == "۱۴۰"


def test_comparable_is_aggressive():
    assert comparable("آئین دادرسیِ مدنی") == comparable("آيين دادرسي مدني")
    assert comparable("سؤال ۱۲:") == "سوال 12"
    assert comparable(f"پاسخ{ZWNJ}نامه") == "پاسخنامه"
