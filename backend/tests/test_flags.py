from __future__ import annotations

from app.models import DocumentResult, Line, PageResult, Word
from app.ocr.flags import is_malformed, known_words, refine_low_conf_flags


def _doc(words: list[Word]) -> DocumentResult:
    page = PageResult(
        index=0,
        width=100,
        height=100,
        source="ocr",
        engine="tesseract",
        lines=[Line(page=0, words=words)],
    )
    return DocumentResult(kind="booklet", filename="x.pdf", pages=[page])


def test_lexicon_loaded():
    words = known_words()
    assert len(words) > 10_000
    assert {"این", "قائممقام", "حقالعملکار"} <= words  # ZWNJ-insensitive keys


def test_known_words_are_not_flagged_at_medium_confidence():
    doc = _doc(
        [Word(text="این", conf=35), Word(text="قائم‌مقام", conf=50), Word(text="زرتق", conf=50)]
    )
    refine_low_conf_flags(doc)
    flags = [w.flag for w in doc.pages[0].lines[0].words]
    assert flags == [None, None, "low_conf"]


def test_document_lexicon_and_thresholds():
    doc = _doc(
        [
            Word(text="کلمه‌نادر", conf=95),
            Word(text="کلمه‌نادر", conf=45),  # trusted: read confidently elsewhere
            Word(text="این", conf=10),  # below the hard floor
            Word(text="جزء۶", conf=80),  # malformed at medium confidence
            Word(text="۱)", conf=40),  # option marker shapes are fine
            Word(text="x", conf=70, flag="disagree"),  # consensus flags are untouched
        ]
    )
    refine_low_conf_flags(doc)
    assert [w.flag for w in doc.pages[0].lines[0].words] == [
        None,
        None,
        "low_conf",
        "low_conf",
        None,
        "disagree",
    ]


def test_malformed_shapes():
    assert is_malformed("جزء۶") and is_malformed("در:تعریف") and is_malformed("قَائُم")
    assert is_malformed("اين") and not is_malformed("این،") and not is_malformed("«د»")
