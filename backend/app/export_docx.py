"""DOCX export in the DADROSE site's official Word-import template.

The site (dadrose-quiz, `adminapi.import_template` + `content.importers.parser`)
already has a Word smart-import with review, duplicate detection and rollback.
This writes exactly the syntax that parser reads, so an exported file can be
uploaded there unchanged:

    سربرگ آزمون            (optional exam header → creates a draft Exam)
    عنوان آزمون: …
    مدت: 170
    سوال 1: <stem>          (renumbered 1..n: the site parser needs consecutive numbers)
    الف) … / ب) … / ج) … / د) …
    پاسخ صحیح: ب
    پاسخ تشریحی: …
    درس: حقوق مدنی          (meta lines apply to the question block they are in)
    منبع: <source title>
"""

from __future__ import annotations

import io
import re

from .blueprints import SUBJECTS, get_blueprint
from .models import Project, Question

LETTERS = {"1": "الف", "2": "ب", "3": "ج", "4": "د"}
_SUBJECT_NAMES = {s["key"]: s["name"] for s in SUBJECTS}
# A line starting like a question/option/meta marker would be re-read as one by the site parser.
_MARKER_START = re.compile(
    r"^\s*(?:(?:س(?:ؤال|وال|ئوال)|پرسش|تست)\s*)?\(?\s*(?:[0-9۰-۹]{1,4}|الف|ب|ج|د|[A-Da-d])\s*[\)\.\-ـ:：]"
    r"|^\s*(?:پاسخ|جواب|کلید|درس|مبحث|موضوع|سطح|سختی|ماده|منبع|توضیح|تشریح)\s*[:：]"
)


def _single_line(text: str) -> str:
    return " ".join(text.split())


def _explanation_lines(text: str) -> list[str]:
    """Explanation paragraphs; continuation lines must not look like markers."""
    paragraphs = [_single_line(p) for p in text.split("\n") if p.strip()]
    out = []
    for i, paragraph in enumerate(paragraphs):
        if i > 0 and _MARKER_START.match(paragraph):
            # glue to the previous paragraph instead of starting a line the parser would misread
            out[-1] = f"{out[-1]} {paragraph}"
        else:
            out.append(paragraph)
    return out


def _questions(project: Project, only_approved: bool) -> list[Question]:
    questions = sorted(project.questions, key=lambda q: q.number)
    return [q for q in questions if q.status == "approved"] if only_approved else questions


def build_lines(project: Project, only_approved: bool, exam_header: bool) -> list[str]:
    lines: list[str] = []
    blueprint = get_blueprint(project.blueprint)
    if exam_header:
        lines.append("سربرگ آزمون")
        lines.append(f"عنوان آزمون: {_single_line(project.title)}")
        if blueprint and blueprint.get("duration_minutes"):
            lines.append(f"مدت: {blueprint['duration_minutes']}")
        lines.append("")

    source_title = _single_line(project.title)
    # The site parser requires consecutive numbering, so questions are renumbered 1..n in
    # order (gaps appear when exporting only approved questions or when numbers are missing).
    for index, q in enumerate(_questions(project, only_approved), start=1):
        lines.append(f"سوال {index}: {_single_line(q.stem)}")
        for option in sorted(q.options, key=lambda o: o.key):
            lines.append(f"{LETTERS.get(option.key, option.key)}) {_single_line(option.text)}")
        if q.correct_key in LETTERS:
            lines.append(f"پاسخ صحیح: {LETTERS[q.correct_key]}")
        explanation = _explanation_lines(q.explanation)
        if explanation:
            lines.append(f"پاسخ تشریحی: {explanation[0]}")
            lines.extend(explanation[1:])
        # meta lines belong to the question block they appear in
        if q.subject_key:
            lines.append(f"درس: {_SUBJECT_NAMES.get(q.subject_key, q.subject_key)}")
        lines.append(f"منبع: {source_title}")
        lines.append("")
    return lines


def to_docx(project: Project, only_approved: bool = False, exam_header: bool = True) -> bytes:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn

    document = Document()
    normal = document.styles["Normal"]
    normal.font.name = "B Nazanin"
    normal.element.rPr.rFonts.set(qn("w:cs"), "B Nazanin")

    for text in build_lines(project, only_approved, exam_header):
        paragraph = document.add_paragraph(text)
        paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        # mark the paragraph right-to-left so Word displays Persian correctly
        p_pr = paragraph._p.get_or_add_pPr()
        bidi = p_pr.makeelement(qn("w:bidi"), {})
        p_pr.append(bidi)
        for run in paragraph.runs:
            r_pr = run._r.get_or_add_rPr()
            r_pr.append(r_pr.makeelement(qn("w:rtl"), {}))

    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()
