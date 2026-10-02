"""Turn OCR lines into structured questions.

The booklet is flattened into a stream of word-level tokens (markers glued to
words are split off, each token keeps its source Word/Line for flags and
regions). A state machine walks the stream: question numbers must follow the
running sequence, option markers restart at 1..4 per question, and the marker
"styles" learned from the whole document (e.g. "۱۲-" for questions, "۱)" for
options) break ties. The answer-key table and explanation sections are parsed
separately and merged by question number.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from itertools import pairwise
from typing import Literal

from .blueprints import detect_subject_heading, get_blueprint, subject_for
from .classify import classify_project
from .models import (
    BBox,
    DocKind,
    DocumentResult,
    Flag,
    Issue,
    Line,
    Option,
    PageResult,
    ParseResult,
    Question,
    Region,
    Word,
)
from .normalize import ZWNJ, comparable, normalize_text, to_ascii_digits, to_persian_digits
from .validate import inline_key_statement, stated_key, validate_project, validate_question

QUESTION_GAP = 5  # max numbers a question marker may skip (missing questions)
EXPLANATION_GAP = 10
LOOKAHEAD_TOKENS = 300
LETTERS = {"الف": 1, "ب": 2, "ج": 3, "د": 4}
# Marker letters incl. common OCR damage ("لف)" for "الف)").
_MARK_LETTERS = {**LETTERS, "لف": 1, "اف": 1}

_DELIMS = r")(\]\[.\-–—ـ:_"
_CORE = r"\d{1,3}|الف|لف|اف|ب|ج|د"
_MARK = re.compile(rf"^([(\[\-–—ـ.)\]]*)({_CORE})([{_DELIMS}]*)$")
_GLUED = re.compile(rf"^([(\[]?(?:{_CORE})[)\].\-–—ـ:]+)(\S+)$")
_PURE_DELIM = re.compile(rf"^[{_DELIMS}]+$")
_CORE_ONLY = re.compile(rf"^(?:{_CORE})$")

# Words after which "۱-" / "ب)" is a reference, not a marker ("ماده ۱-", "بند ب)").
_GUARD_WORDS = {
    comparable(w)
    for w in (
        "ماده",
        "مواد",
        "بند",
        "بندهای",
        "تبصره",
        "تبصره‌های",
        "اصل",
        "فصل",
        "مبحث",
        "جزء",
        "شماره",
        "ردیف",
        "صفحه",
        "فقره",
        "قسمت",
        "کتاب",
        "باب",
        "مرحله",
        "درجه",
        "سال",
        "ماه",
        "روز",
        "قانون",
    )
}


# ----------------------------------------------------------------------- tokens


@dataclass(eq=False)
class _Tok:
    text: str
    word: Word
    line: Line
    first: bool  # first token of its line
    glued: bool = False  # split off the previous token's word (no space when joined)
    # A whole heading line collapsed into one token: its subject key, or "" for a
    # structural heading ("فصل نخست: ...") that names no subject.
    heading: str | None = None


@dataclass(frozen=True)
class _Marker:
    value: int
    kind: str  # "digit" | "letter"
    style: str  # ")", "-", ".", ":" or "" (bare number)
    size: int  # tokens consumed
    first: bool

    @property
    def sig(self) -> tuple[str, str]:
        return (self.kind, self.style)


def _style_of(ch: str) -> str:
    if ch in "()[]":
        return ")"
    if ch in "-–—ـ_":
        return "-"
    return ch


def _split_word(text: str) -> list[str]:
    text = normalize_text(text).strip("*#•▪")  # markdown emphasis / bullets from AI output
    if not text:
        return []
    m = _GLUED.match(text)
    if m:
        return [m.group(1), m.group(2)]
    return [text]


def _line_tokens(line: Line) -> list[_Tok]:
    toks: list[_Tok] = []
    for word in line.words:
        for k, part in enumerate(_split_word(word.text)):
            toks.append(_Tok(part, word, line, first=not toks, glued=k > 0))
    return toks


def _marker_at(toks: list[_Tok], i: int, allow_bare: bool | None = None) -> _Marker | None:
    t = toks[i]
    if t.heading is not None:
        return None
    if allow_bare is None:
        allow_bare = t.first
    nxt = toks[i + 1] if i + 1 < len(toks) and not toks[i + 1].first else None
    m = _MARK.match(t.text.replace(ZWNJ, ""))
    if m:
        lead, core, trail = m.groups()
        size = 1
        delims = trail or lead
        if not delims and nxt is not None and _PURE_DELIM.match(nxt.text):
            delims, size = nxt.text, 2  # "۱۲" "-" split into two words
        kind = "letter" if core in _MARK_LETTERS else "digit"
        value = _MARK_LETTERS.get(core) or int(to_ascii_digits(core))
        if value == 0:
            return None
        if not delims:
            if kind == "letter" or not allow_bare:
                return None
            return _Marker(value, kind, "", size, t.first)
        return _Marker(value, kind, _style_of(delims[0]), size, t.first)
    # "(" "۱" / "-" "۱۲" split at line start (RTL extraction artifact)
    if t.first and _PURE_DELIM.match(t.text) and nxt is not None and _CORE_ONLY.match(nxt.text):
        kind = "letter" if nxt.text in _MARK_LETTERS else "digit"
        value = _MARK_LETTERS.get(nxt.text) or int(to_ascii_digits(nxt.text))
        if value:
            return _Marker(value, kind, _style_of(t.text[0]), 2, True)
    return None


def _guarded(toks: list[_Tok], i: int) -> bool:
    return i > 0 and comparable(toks[i - 1].text) in _GUARD_WORDS


# ------------------------------------------------------------------------ noise

_ALWAYS_NOISE = [
    re.compile(r"^(صفحه|page|pg)\s*[:.]?\s*\d+(\s*(از|/|of)\s*\d+)?$", re.IGNORECASE),
    re.compile(r"scanned\s+(with|by)|camscanner|https?://|www\.|t\.me/", re.IGNORECASE),
    re.compile(r"^(موفق|پیروز) باشید"),
    re.compile(r"^پایان( سؤالات| سوالات| آزمون)?[.!]?$"),
]
_PAGE_NUMBER = re.compile(r"^(\d{1,4}|[-–—(\[|]\s*\d{1,4}\s*[-–—)\]|]|\d{1,4}\s*(از|/)\s*\d{1,4})$")


_SECTION_HEADING = re.compile(r"^(بخش|فصل|مبحث|گفتار|قسمت|باب|درس|مقدمه)(\s+[^\s:]+){0,2}\s*:")


_HEADING_LEVELS = {"بخش": 1, "فصل": 2, "مبحث": 3, "گفتار": 4}


def _heading_level(t: _Tok) -> int:
    """0 for a subject heading ("حقوق مدنی"), else by the structural word."""
    if t.heading:
        return 0
    return _HEADING_LEVELS.get(t.text.split()[0] if t.text else "", 2)


def _is_section_heading(text: str) -> bool:
    """Structural headings like "فصل نخست: تعریف تاجر"."""
    text = normalize_text(text)
    return len(text.split()) <= 14 and bool(_SECTION_HEADING.match(text))


def _band_noise(line: Line, idx: int, n_lines: int) -> bool:
    """Running header/footer in the top/bottom page band (often OCR garbage)."""
    box = _line_bbox(line)
    if box is None:
        return False
    if not ((idx < 4 and box[3] < 0.09) or (idx >= n_lines - 3 and box[1] > 0.95)):
        return False
    text = to_ascii_digits(normalize_text(line.text))
    words = text.split()
    numbered = any(re.fullmatch(r"\d{1,3}", w) for w in (words[0], words[-1])) if words else False
    if (
        not text
        or detect_subject_heading(text)
        or (_is_section_heading(text) and not numbered)  # running header = heading + page no.
        or _is_key_heading(line)
        or comparable(text).split()[0] in _SECTION_PREFIX  # "پاسخ سؤال ۱"
    ):
        return False
    toks = _line_tokens(line)
    m = _marker_at(toks, 0) if toks else None
    if m and m.style:
        return False
    flagged = sum(1 for w in line.words if w.flag) >= 0.5 * len(line.words)
    width = box[2] - box[0]
    return numbered or flagged or width < 0.12 or (width < 0.35 and bool(re.search(r"\d", text)))


def _noise_lines(doc: DocumentResult) -> set[int]:
    """ids of Line objects that are headers/footers/page numbers/watermarks."""
    noise: set[int] = set()
    edge_texts: dict[str, set[int]] = {}
    for page in doc.pages:
        lines = [ln for ln in page.lines if ln.words]
        for idx, line in enumerate(lines):
            text = to_ascii_digits(normalize_text(line.text))
            at_edge = idx < 2 or idx >= len(lines) - 2
            if (
                any(p.search(text) for p in _ALWAYS_NOISE)
                or (at_edge and _PAGE_NUMBER.match(text))
                or _band_noise(line, idx, len(lines))
            ):
                noise.add(id(line))
            elif (idx < 3 or idx >= len(lines) - 3) and not detect_subject_heading(text):
                toks = _line_tokens(line)
                if toks and _marker_at(toks, 0) is None:
                    key = re.sub(r"\d+", "", comparable(text)).strip()
                    if key:
                        edge_texts.setdefault(key, set()).add(page.index)
    n_pages = len(doc.pages)
    repeated = {
        k
        for k, pages in edge_texts.items()
        if len(pages) >= max(3, 0.3 * n_pages)
        and (len(k.split()) >= 2 or len(pages) >= 0.6 * n_pages)
    }
    if repeated:
        for page in doc.pages:
            lines = [ln for ln in page.lines if ln.words]
            for idx, line in enumerate(lines):
                at_edge = idx < 3 or idx >= len(lines) - 3
                if at_edge and re.sub(r"\d+", "", comparable(line.text)).strip() in repeated:
                    noise.add(id(line))
    return noise


def _content_lines(doc: DocumentResult) -> list[Line]:
    noise = _noise_lines(doc)
    return [
        ln
        for page in doc.pages
        for ln in _fix_row_order([ln for ln in page.lines if ln.words and id(ln) not in noise])
    ]


def _same_row(a: BBox, b: BBox) -> bool:
    overlap = min(a[3], b[3]) - max(a[1], b[1])
    height = min(a[3] - a[1], b[3] - b[1])
    if height <= 0:
        return abs((a[1] + a[3]) - (b[1] + b[3])) < 0.01
    return overlap > 0.5 * height


def _fix_row_order(lines: list[Line]) -> list[Line]:
    """OCR sometimes emits the left part of a row before its right part (RTL); swap them."""
    out = list(lines)
    i = 0
    while i < len(out):
        a = _line_bbox(out[i])
        moved = False
        if a is not None:
            for k in range(i + 1, min(i + 4, len(out))):
                b = _line_bbox(out[k])
                if b is not None and _same_row(a, b) and b[0] >= a[2] - 0.02:
                    out.insert(k, out.pop(i))
                    moved = True
                    break
        if not moved:
            i += 1
    return out


# -------------------------------------------------------------------- key table

_KEY_FILLER = {
    comparable(w)
    for w in (
        "سوال",
        "سؤال",
        "سوالات",
        "پاسخ",
        "پاسخها",
        "گزینه",
        "شماره",
        "کلید",
        "صحیح",
        "جواب",
        "ردیف",
        "درست",
    )
}
_KEY_HEADINGS = ("کلید", "پاسخنامه", "پاسخ نامه", "پاسخ صحیح", "پاسخهای صحیح", "جدول پاسخ")


def _atoms(text: str) -> tuple[list[tuple[int, bool]], int]:
    """(numbers / answer letters in order as (value, is_letter), count of other words)."""
    s = to_ascii_digits(normalize_text(text)).replace(ZWNJ, "")
    atoms: list[tuple[int, bool]] = []
    other = 0
    for tok in re.findall(r"\d+|[^\W\d_]+", s):
        if tok.isdigit():
            atoms.append((int(tok), False))
        elif tok in LETTERS:
            atoms.append((LETTERS[tok], True))
        elif comparable(tok) not in _KEY_FILLER:
            other += 1
    return atoms, other


_ROW_LABELS = {
    **{comparable(w): "q" for w in ("سوال", "سؤال", "سوالات", "شماره", "ردیف")},
    **{comparable(w): "a" for w in ("پاسخ", "گزینه", "جواب", "کلید")},
}


def _row_label(text: str) -> str | None:
    """ "q"/"a" for grid rows labelled like "| سؤال | ۱ | ۲ |" / "| پاسخ | ۳ | ۱ |"."""
    words = [
        w
        for w in re.findall(r"[^\W\d_]+", normalize_text(text).replace(ZWNJ, ""))
        if w not in LETTERS
    ]
    return _ROW_LABELS.get(comparable(words[0])) if len(words) == 1 else None


def _key_like(line: Line) -> bool:
    atoms, other = _atoms(line.text)
    return len(atoms) >= 2 and other <= 1


def _is_key_heading(line: Line) -> bool:
    text = comparable(line.text)
    return len(text.split()) <= 8 and any(h in text for h in _KEY_HEADINGS)


def _key_region(lines: list[Line], page_count: int) -> set[int]:
    """ids of lines belonging to the answer-key table."""
    region: set[int] = set()
    for h, line in enumerate(lines):
        if not _is_key_heading(line):
            continue
        window = lines[h + 1 : h + 11]
        if window and sum(map(_key_like, window)) >= 0.5 * len(window):
            region.update(id(ln) for ln in lines[h:])
            break
    by_page: dict[int, list[Line]] = {}
    for line in lines:
        by_page.setdefault(line.page, []).append(line)
    for page, page_lines in by_page.items():
        if page_count < 2 or page < page_count // 2:
            continue
        hits = sum(map(_key_like, page_lines))
        if hits >= 4 and hits >= 0.7 * len(page_lines):
            # option lines like "۱) الف ۲) ب" also look like pairs; a real key covers more numbers
            parsed, _ = _parse_key(page_lines)
            if len(parsed) >= 4 and max(parsed) >= 5:
                region.update(id(ln) for ln in page_lines)
    return region


def _parse_key(lines: list[Line]) -> tuple[dict[int, str], bool]:
    """Parse pairs ("۱۲-۳", "۱۲ : ج"), "|" rows and grids. Returns (key, partial)."""
    key: dict[int, str] = {}
    partial = False
    header: list[int] | None = None  # pending row of question numbers
    answers: list[int] | None = None  # pending row of answers (header may follow)
    reversed_pairs = False  # learned orientation for ambiguous pairs (answer before number)

    def put(q: int, a: int) -> None:
        if 1 <= q <= 400 and 1 <= a <= 4:
            key.setdefault(q, str(a))

    def is_run(vals: list[tuple[int, bool]]) -> bool:
        if len(vals) < 3 or any(letter for _, letter in vals):
            return False
        nums = [v for v, _ in vals]
        step = nums[1] - nums[0]
        return step in (1, -1) and all(b - a == step for a, b in pairwise(nums))

    for line in lines:
        if _is_key_heading(line) and not _key_like(line):
            continue
        atoms, _ = _atoms(line.text)
        if not atoms:
            continue
        values = [v for v, _ in atoms]
        all_answers = all(v <= 4 for v in values)
        label = _row_label(line.text)
        if label == "q" and not any(letter for _, letter in atoms):
            if header is not None:
                partial = True
            header = values
            continue
        if header is not None and all_answers and len(atoms) == len(header):
            for q, a in zip(header, values, strict=True):
                put(q, a)
            header = None
            continue
        if is_run(atoms):
            if answers is not None and len(answers) == len(atoms):
                for q, a in zip(values, answers, strict=True):
                    put(q, a)
                answers = None
            else:
                if header is not None:
                    partial = True
                header = values
            continue
        if header is not None:
            partial = True  # a number row with no matching answer row
            header = None
        if len(atoms) == 2:
            (x, xl), (y, yl) = atoms
            if yl or (x > 4 and y <= 4):
                put(x, y)
                reversed_pairs = False
            elif xl or (x <= 4 and y > 4):
                put(y, x)
                reversed_pairs = True
            elif reversed_pairs:
                put(y, x)
            else:
                put(x, y)
            continue
        if len(atoms) % 2 == 0:
            evens, odds = values[0::2], values[1::2]
            even_letters = any(letter for _, letter in atoms[0::2])
            odd_letters = any(letter for _, letter in atoms[1::2])

            def increasing(seq: list[int]) -> bool:
                return all(b > a for a, b in pairwise(seq))

            if not even_letters and increasing(evens) and all(v <= 4 for v in odds):
                for q, a in zip(evens, odds, strict=True):
                    put(q, a)
                continue
            if not odd_letters and increasing(odds) and all(v <= 4 for v in evens):
                for q, a in zip(odds, evens, strict=True):
                    put(q, a)
                continue
        if all_answers and len(atoms) >= 3:
            answers = values
            continue
        partial = True
    if header is not None or answers is not None:
        partial = True
    return key, partial


# ----------------------------------------------------------------- booklet FSM


@dataclass(eq=False)
class _Build:
    number: int
    subject: str | None = None
    fields: dict[str, list[_Tok]] = field(default_factory=lambda: {"stem": []})
    marker_toks: dict[str, list[_Tok]] = field(default_factory=dict)
    opt_sig: tuple[str, str] | None = None
    nopts: int = 0
    current: str = "stem"  # field receiving tokens ("stem", "option:N", "explanation")
    path: list[str] = field(default_factory=list)  # headings above the question
    inline_key: str | None = None  # stated right after the options (test books)


class _BookletParser:
    def __init__(self, toks: list[_Tok], single: bool = False) -> None:
        self.toks = toks
        self.single = single
        self.subject: str | None = None
        self.path: list[tuple[int, str]] = []  # (level, heading text)
        self.questions: list[_Build] = []
        self.cur: _Build | None = None
        self.q_style, self.o_sig = self._learn_styles()

    def _learn_styles(self) -> tuple[str | None, tuple[str, str] | None]:
        q_styles: Counter[str] = Counter()
        o_sigs: Counter[tuple[str, str]] = Counter()
        for i in range(len(self.toks)):
            m = _marker_at(self.toks, i)
            if m is None:
                continue
            if m.kind == "digit" and m.first and m.value >= 5:
                q_styles[m.style] += 1
            if m.value <= 4 and m.style:
                o_sigs[m.sig] += 1
        q_style = None
        if q_styles:
            style, count = q_styles.most_common(1)[0]
            q_style = style if count >= 2 else None
        o_sig = None
        if o_sigs:
            o_sig = max(o_sigs, key=lambda s: (o_sigs[s] * (1.5 if s[0] == "digit" else 1), s))
        return q_style, o_sig

    @property
    def o_style(self) -> str | None:
        return self.o_sig[1] if self.o_sig else None

    def run(self) -> list[_Build]:
        toks = self.toks
        if self.single:
            self.cur = _Build(number=0)
            self.questions.append(self.cur)
        i = 0
        while i < len(toks):
            t = toks[i]
            if t.heading is not None:
                self.subject = t.heading or self.subject
                level = _heading_level(t)
                self.path = [(lv, h) for lv, h in self.path if lv < level] + [(level, t.text)]
                i += 1
                continue
            if t.first and self._inline_explanation_starts(i):
                i = self._start_inline_explanation(i)
                continue
            m = _marker_at(toks, i)
            action = self._decide(m, i) if m else None
            if m and action == "question":
                self._start_question(m, i)
                i += m.size
                continue
            if m and action == "option":
                self._start_option(m, i)
                i += m.size
                continue
            if self.cur is not None:
                self.cur.fields[self.cur.current].append(t)
            i += 1
        return self.questions

    # -- decisions

    def _decide(self, m: _Marker, i: int) -> str | None:
        q_ok = self._question_ok(m, i)
        o_ok = self._option_ok(m, i)
        if q_ok and o_ok:
            if self.q_style and m.style == self.q_style != self.o_style:
                return "question"
            return "option"
        return "question" if q_ok else "option" if o_ok else None

    def _question_ok(self, m: _Marker, i: int) -> bool:
        if m.kind != "digit":
            return False
        cur = self.cur
        if self.single:
            # Re-OCR of one question: only a leading number can be its number.
            return (
                cur is not None
                and cur.number == 0
                and i == 0
                and not (m.value == 1 and self._sequence_ahead(i + m.size, m.sig, 2))
            )
        if cur is None:
            if not m.first or m.style == "":
                return False
            return (
                m.value == 1
                or (bool(self.q_style) and m.style == self.q_style)
                or (m.style != self.o_style and m.value > 4)
                or (self.o_sig is not None and self.o_sig[0] == "letter")
            )
        if self._is_restart(m):
            return True
        expected = cur.number + 1
        if not expected <= m.value <= expected + QUESTION_GAP:
            return False
        if cur.nopts == 0 and self._reappears_after_options(i + m.size, m):
            return False  # a numbered item inside the stem; the real question comes later
        if cur.current == "explanation" and not self._options_follow(i + m.size, m):
            return False  # a numbered list inside an inline explanation
        if not m.first:
            return (
                cur.nopts >= 4
                and m.value == expected
                and bool(self.q_style)
                and m.style == self.q_style != self.o_style
            )
        if m.style == "":
            return m.value == expected and (self.q_style == "" or cur.nopts >= 4)
        if m.value > expected:
            return m.style == self.q_style if self.q_style else cur.nopts >= 4
        return True

    def _option_ok(self, m: _Marker, i: int) -> bool:
        cur = self.cur
        if cur is None or cur.current == "explanation":
            return False
        if cur.nopts >= 4 or m.value != cur.nopts + 1:
            return False
        if m.style == "" and (self.o_sig is None or self.o_sig[1] != ""):
            return False
        if m.value == 1:
            if not m.first and _guarded(self.toks, i):
                return False
            if self.o_sig and m.sig != self.o_sig:
                return self._own_sequence_wins(i + m.size, m.sig)
            if not m.first:
                return self._sequence_ahead(i + m.size, m.sig, 2)
            return True
        assert cur.opt_sig is not None
        if m.kind != cur.opt_sig[0]:
            return False
        if m.first:
            return m.style == cur.opt_sig[1] or not _guarded(self.toks, i)
        return m.style == cur.opt_sig[1] and not _guarded(self.toks, i)

    # -- inline explanations (test books: "گزینه‌ی «د» درست است." after the options)

    def _line_end(self, i: int) -> int:
        j = i + 1
        while j < len(self.toks) and not self.toks[j].first:
            j += 1
        return j

    def _inline_explanation_starts(self, i: int) -> bool:
        cur = self.cur
        if cur is None or cur.nopts < 2 or cur.current == "explanation":
            return False
        text = " ".join(t.text for t in self.toks[i : self._line_end(i)])
        key = inline_key_statement(text)
        if key is None:
            return False
        cur.inline_key = key
        return True

    def _start_inline_explanation(self, i: int) -> int:
        cur = self.cur
        assert cur is not None
        end = self._line_end(i)
        explanation = list(self.toks[i:end])
        # OCR line-order glitch: explanation fragments that landed after the last option
        # (lines not reaching the right margin, after the option's own first line).
        option = cur.fields[cur.current]
        if cur.current.startswith("option:") and option:
            boxes = [b for t in option if (b := _line_bbox(t.line))]
            margin = max((b[2] for b in boxes), default=1.0)
            marker_line = id(cur.marker_toks.get(cur.current, option[:1])[0].line)
            moved: list[_Tok] = []
            while option and id(option[-1].line) != marker_line and len(moved) < 60:
                line = option[-1].line
                box = _line_bbox(line)
                if box is None or box[2] > margin - 0.1:
                    break
                while option and option[-1].line is line:
                    moved.insert(0, option.pop())
            explanation += moved
        cur.current = "explanation"
        cur.fields["explanation"] = explanation
        return end

    def _options_follow(self, start: int, m: _Marker) -> bool:
        """A question marker inside an explanation is real only if options follow it."""
        if self.o_sig is None:
            return True
        for j in range(start, min(len(self.toks), start + LOOKAHEAD_TOKENS)):
            n = _marker_at(self.toks, j)
            if n is None:
                continue
            if n.value == 1 and n.kind == self.o_sig[0] and n.style:
                return True
            if n.first and n.kind == "digit" and n.style == m.style and n.value >= m.value:
                return False
        return False

    def _is_restart(self, m: _Marker) -> bool:
        """Numbered instructions ("۱- ... ۲- ...") before the real first question."""
        cur = self.cur
        if cur is None or m.value != 1 or not m.first or any(q.nopts for q in self.questions):
            return False
        stem = cur.fields["stem"]
        return any(
            t.first
            and (n := _marker_at(stem, k)) is not None
            and n.value == 2
            and n.style == m.style
            for k, t in enumerate(stem)
        )

    def _reappears_after_options(self, start: int, m: _Marker) -> bool:
        seen_options = False
        for j in range(start, min(len(self.toks), start + 2 * LOOKAHEAD_TOKENS)):
            n = _marker_at(self.toks, j)
            if n is None:
                continue
            if n.value == 1 and (n.sig == self.o_sig or self.o_sig is None):
                seen_options = True
            elif seen_options and n.first and n.kind == "digit" and n.style == m.style:
                return n.value <= m.value
        return False

    def _own_sequence_wins(self, start: int, sig: tuple[str, str]) -> bool:
        """A "1" marker in an unusual style: real options, or items inside the stem?

        Follow its own sequence (2, 3, 4); meeting the document's usual option "1"
        first means these were stem items ("الف) ... د)" then "۱) ... ۴)").
        """
        expect = 2
        next_q = self.cur.number + 1 if self.cur else None
        for j in range(start, min(len(self.toks), start + LOOKAHEAD_TOKENS)):
            n = _marker_at(self.toks, j)
            if n is None or (not n.first and _guarded(self.toks, j)):
                continue
            if n.sig == sig and n.value == expect:
                expect += 1
            elif n.sig == self.o_sig and n.value == 1:
                return False
            elif n.first and n.kind == "digit" and n.value == next_q:
                break
        return expect >= 3

    def _sequence_ahead(self, start: int, sig: tuple[str, str], value: int) -> bool:
        """Is there a `value` marker with `sig` ahead, before the next question starts?"""
        next_q = self.cur.number + 1 if self.cur else None
        for j in range(start, min(len(self.toks), start + LOOKAHEAD_TOKENS)):
            m = _marker_at(self.toks, j)
            if m is None:
                continue
            if (
                not self.single
                and next_q
                and m.first
                and m.kind == "digit"
                and m.value == next_q
                and (self.q_style is None or m.style == self.q_style)
                and m.sig != sig
            ):
                return False
            if m.sig == sig and m.value == value and (m.first or not _guarded(self.toks, j)):
                return True
        return False

    # -- transitions

    def _start_question(self, m: _Marker, i: int) -> None:
        markers = self.toks[i : i + m.size]
        if self.single and self.cur is not None:
            self.cur.number = m.value
            self.cur.marker_toks["stem"] = markers
            return
        if self._is_restart(m):
            self.questions.clear()
        self.cur = _Build(number=m.value, subject=self.subject, path=[h for _, h in self.path])
        self.cur.marker_toks["stem"] = markers
        self.questions.append(self.cur)

    def _start_option(self, m: _Marker, i: int) -> None:
        cur = self.cur
        assert cur is not None
        cur.nopts += 1
        if cur.nopts == 1:
            cur.opt_sig = m.sig
        cur.current = f"option:{cur.nopts}"
        cur.fields[cur.current] = []
        cur.marker_toks[cur.current] = self.toks[i : i + m.size]


# ------------------------------------------------------------- explanations FSM

_SECTION_PREFIX = {comparable(w) for w in ("سوال", "سؤال", "پاسخ", "جواب")}


@dataclass
class _SectionMarker:
    value: int
    size: int
    prefix: bool
    style: str
    stmt: bool


@dataclass(eq=False)
class _Section:
    number: int
    marker: list[_Tok]
    toks: list[_Tok] = field(default_factory=list)


def _section_marker(toks: list[_Tok], i: int) -> _SectionMarker | None:
    if not toks[i].first or toks[i].heading is not None:
        return None
    j = i
    while (
        j < len(toks)
        and j - i < 3
        and (j == i or not toks[j].first)
        and comparable(toks[j].text) in _SECTION_PREFIX
    ):
        j += 1
    if j >= len(toks) or (j > i and toks[j].first):
        return None
    m = _marker_at(toks, j, allow_bare=True)
    if m is None or m.kind != "digit":
        return None
    end = j + m.size
    head: list[str] = []
    for k in range(end, min(end + 12, len(toks))):
        if toks[k].heading is not None or (toks[k].first and _marker_at(toks, k)):
            break
        head.append(toks[k].text)
    return _SectionMarker(
        m.value, end - i, j > i, m.style, stated_key(" ".join(head), 60) is not None
    )


def _parse_explanations(toks: list[_Tok], known: set[int]) -> list[_Section]:
    candidates = [c for i in range(len(toks)) if (c := _section_marker(toks, i))]
    with_stmt = [c for c in candidates if c.stmt]
    strong = len(with_stmt) >= 3
    prefix_mode = sum(c.prefix for c in candidates) >= 3
    styles = Counter(c.style for c in (with_stmt or candidates))
    sec_style = styles.most_common(1)[0][0] if styles else None

    def accept(c: _SectionMarker, last: int) -> bool:
        if last and not last < c.value <= last + EXPLANATION_GAP:
            return False
        if not last and c.value > 400:
            return False
        if known and c.value not in known and not (c.stmt or c.prefix):
            return False
        if c.prefix:
            return True
        if prefix_mode:
            return c.stmt
        if c.stmt:
            return True
        if strong:
            return c.style == sec_style and c.value == last + 1 and c.value > 6
        return c.style == sec_style

    sections: list[_Section] = []
    i = 0
    while i < len(toks):
        c = _section_marker(toks, i)
        last = sections[-1].number if sections else 0
        if c and accept(c, last):
            sections.append(_Section(c.value, toks[i : i + c.size]))
            i += c.size
            continue
        if sections and toks[i].heading is None:
            sections[-1].toks.append(toks[i])
        i += 1
    return sections


# ---------------------------------------------------------------------- output


def _line_bbox(line: Line) -> BBox | None:
    if line.bbox:
        return line.bbox
    boxes = [w.bbox for w in line.words if w.bbox]
    return _union(boxes) if boxes else None


def _union(boxes: list[BBox]) -> BBox:
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def _regions(toks: list[_Tok], doc: DocKind) -> list[Region]:
    by_page: dict[int, list[BBox]] = {}
    seen: set[int] = set()
    for t in toks:
        if id(t.line) in seen:
            continue
        seen.add(id(t.line))
        box = _line_bbox(t.line)
        if box:
            by_page.setdefault(t.line.page, []).append(box)
    return [Region(doc=doc, page=p, bbox=_union(b)) for p, b in sorted(by_page.items())]


def _flags(toks: list[_Tok], field_name: str, doc: DocKind) -> list[Flag]:
    flags: list[Flag] = []
    seen: set[int] = set()
    for t in toks:
        w = t.word
        if w.flag and id(w) not in seen:
            seen.add(id(w))
            flags.append(
                Flag(
                    field=field_name,
                    word=w.text,
                    doc=doc,
                    page=t.line.page,
                    bbox=w.bbox,
                    reason=w.flag,
                    alt=w.alt,
                )
            )
    return flags


def _join(toks: list[_Tok], paragraphs: bool = False) -> str:
    parts: list[str] = []
    for i, t in enumerate(toks):
        if paragraphs and parts and t.first and _marker_at(toks, i) is not None:
            parts.append("\n")
        if t.glued and parts:
            parts[-1] += t.text
        else:
            parts.append(t.text)
    return normalize_text(" ".join(parts))


_PARENS = re.compile(r"\(\s*([^()]{2,60}?)\s*\)")
_EXAM_WORDS = {
    comparable(w)
    for w in (
        "ارشد",
        "سراسری",
        "آزاد",
        "وکالت",
        "قضاوت",
        "قضایی",
        "کانون",
        "سردفتری",
        "دفتریاری",
        "مرکز",
        "کارشناسی",
        "دکتری",
        "کنکور",
        "آزمون",
        "مشاوران",
        "مشاور",
        "کارآموزی",
        "داوری",
        "دادگستری",
        "سنجش",
        "نیمه‌متمرکز",
        "دانشگاه",
    )
}


def _find_source_ref(text: str) -> re.Match[str] | None:
    """A printed source tag like "(ارشد سراسری-۷۸)" / "(قضاوت ۱۴۰۰)"; last one wins."""
    found = None
    for m in _PARENS.finditer(text):
        inner = comparable(m.group(1))
        words = inner.split()
        if (
            words
            and words[0] not in _GUARD_WORDS
            and any(w in _EXAM_WORDS for w in words)
            and re.search(r"(?<!\d)\d{2,4}(?!\d)", inner)
            and len(words) <= 8
        ):
            found = m
    return found


def _extract_source_ref(q: Question) -> None:
    """Move a source tag from the stem (or, after OCR reordering, an option or the
    explanation) into `source_ref`."""
    fields: list[tuple[str, str]] = [("stem", q.stem)]
    fields += [(f"option:{o.key}", o.text) for o in reversed(q.options)]
    fields.append(("explanation", q.explanation))
    for name, text in fields:
        m = _find_source_ref(text)
        if m is None:
            continue
        q.source_ref = re.sub(r"\s*([-–/])\s*", r"\1", normalize_text(m.group(1)))
        rest = normalize_text(text[: m.start()] + " " + text[m.end() :])
        if name == "stem":
            q.stem = rest
        elif name == "explanation":
            q.explanation = rest
        else:
            next(o for o in q.options if f"option:{o.key}" == name).text = rest
        return


def _to_question(b: _Build) -> Question:
    options = [
        Option(key=str(k), text=_join(b.fields.get(f"option:{k}", [])))
        for k in range(1, b.nopts + 1)
    ]
    flags: list[Flag] = []
    all_toks: list[_Tok] = []
    for name, toks in b.fields.items():
        marker = b.marker_toks.get(name, [])
        flags.extend(_flags(marker + toks, name, "booklet"))
        all_toks.extend(marker + toks)
    q = Question(
        number=b.number,
        subject_key=b.subject,
        stem=_join(b.fields["stem"]),
        options=options,
        explanation=_join(b.fields.get("explanation", []), paragraphs=True),
        flags=flags,
        regions=_regions(all_toks, "booklet"),
    )
    q.classification.section_path = list(b.path)
    if b.inline_key:
        q.correct_key, q.key_source = b.inline_key, "inline"
    _extract_source_ref(q)
    return q


def _tokenize(lines: list[Line], headings: bool) -> list[_Tok]:
    toks: list[_Tok] = []
    for line in lines:
        line_toks = _line_tokens(line)
        if not line_toks:
            continue
        if headings and _marker_at(line_toks, 0) is None:
            subject = detect_subject_heading(line.text)
            if subject or _is_section_heading(line.text):
                text = normalize_text(line.text)
                toks.append(_Tok(text, line.words[0], line, first=True, heading=subject or ""))
                continue
        toks.extend(line_toks)
    return toks


# ------------------------------------------------------------------------- API


def build_questions(
    booklet: DocumentResult,
    explanations: DocumentResult | None,
    blueprint: str,
    default_subject: str | None = None,
) -> ParseResult:
    lines = _content_lines(booklet)
    key_ids = _key_region(lines, len(booklet.pages))
    key, key_partial = _parse_key([ln for ln in lines if id(ln) in key_ids])
    body = [ln for ln in lines if id(ln) not in key_ids]

    builds = _BookletParser(_tokenize(body, headings=True)).run()
    questions = [_to_question(b) for b in builds]
    has_bp = get_blueprint(blueprint) is not None
    for q in questions:
        if has_bp:
            q.subject_key = subject_for(blueprint, q.number) or q.subject_key
        if q.number in key:  # the official table wins over an inline statement
            q.correct_key, q.key_source = key[q.number], "table"

    doc_issues: list[Issue] = []
    if key_partial and key:
        doc_issues.append(
            Issue(
                level="warning",
                code="key_table_partial",
                message="بخشی از جدول کلید قابل خواندن نبود؛ کلیدها را بررسی کنید.",
            )
        )
    has_expl = explanations is not None
    if explanations is not None:
        by_number = {q.number: q for q in questions}
        expl_toks = _tokenize(_content_lines(explanations), headings=True)
        orphans: list[int] = []
        for section in _parse_explanations(expl_toks, set(by_number)):
            q = by_number.get(section.number)
            if q is None:
                orphans.append(section.number)
                continue
            _attach_explanation(q, section)
        if orphans:
            doc_issues.append(
                Issue(
                    level="warning",
                    code="orphan_explanation",
                    message="پاسخ تشریحی برای سؤال‌های ناموجود: "
                    + "، ".join(to_persian_digits(n) for n in orphans),
                )
            )

    classify_project(questions, blueprint=blueprint, default_subject=default_subject)
    for q in questions:
        q.issues = validate_question(q, has_expl)
    bp = get_blueprint(blueprint)
    expected = bp["question_count"] if bp else None
    issues = validate_project(questions, has_expl, expected) + doc_issues
    return ParseResult(questions=questions, issues=issues)


def _attach_explanation(q: Question, section: _Section) -> None:
    text = _join(section.toks, paragraphs=True)
    if q.explanation:  # duplicated section: keep both
        text = q.explanation + "\n" + text
    q.explanation = text
    q.flags.extend(_flags(section.marker + section.toks, "explanation", "explanations"))
    q.regions.extend(_regions(section.marker + section.toks, "explanations"))
    if not q.correct_key:
        expl_key = stated_key(text)
        if expl_key:
            q.correct_key, q.key_source = expl_key, "explanation"


def parse_single_question(lines: list[Line], doc_kind: DocKind) -> Question | None:
    """Re-parse one question from the re-OCR of its region(s).

    Booklet: returns stem/options/flags/regions; `number` is the leading question
    number when one was read, else 0 (callers keep their own number). Explanations:
    returns a Question whose `explanation`, `flags` and `regions` hold the section
    text (and `correct_key` the stated key, if any). Issues are not filled.
    """
    lines = [ln for ln in lines if ln.words]
    toks = _tokenize(lines, headings=False)
    if not toks:
        return None
    if doc_kind == "explanations":
        number = 0
        c = _section_marker(toks, 0)
        if c:
            number, marker, toks = c.value, toks[: c.size], toks[c.size :]
        else:
            marker = []
        q = Question(number=number)
        _attach_explanation(q, _Section(number, marker, toks))
        return q if q.explanation else None
    builds = _BookletParser(toks, single=True).run()
    q = _to_question(builds[0])
    if not q.stem and not q.options:
        return None
    return q


# ------------------------------------------------------------------ full text

_BULLET = re.compile(r"^[•▪●○◦*\-–—]\s*\S")
_NOTE_ITEM = re.compile(
    r"^(نکته|تبصره|ماده|اصل|مثال|توجه|یادآوری|سؤال|سوال|پاسخ)\s*[\d۰-۹]*\s*[:：\-]"
)
_BLOCK_END = ("؟", "!", ":", "：")
_SOFT_END = (".", "»", "؛")


def _starts_block(line: Line, text: str) -> bool:
    toks = _line_tokens(line)
    m = _marker_at(toks, 0) if toks else None
    return bool(
        (m and m.style)
        or _BULLET.match(text)
        or _NOTE_ITEM.match(text)
        or _is_section_heading(text)
        or detect_subject_heading(text)
        or _is_key_heading(line)
        or inline_key_statement(text)
    )


def _plain_text(lines: list[Line]) -> str:
    """Reflow OCR lines into paragraphs, one per output line."""
    boxes = {id(ln): _line_bbox(ln) for ln in lines}
    known = [b for b in boxes.values() if b]
    block_left = min((b[0] for b in known), default=0.0)
    gaps = sorted(
        b[1] - a[3]
        for p, n in pairwise(lines)
        if (a := boxes[id(p)]) and (b := boxes[id(n)]) and p.page == n.page and b[1] > a[3]
    )
    usual_gap = gaps[len(gaps) // 2] if gaps else 0.0
    paragraphs: list[list[str]] = []
    prev: Line | None = None
    prev_text = ""
    prev_heading = False
    for line in lines:
        text = normalize_text(line.text).replace("**", "").strip()
        if not text:
            continue
        a = boxes[id(prev)] if prev is not None else None
        b = boxes[id(line)]
        same_row = (
            a is not None and b is not None and _same_row(a, b) and b[2] <= a[0] + 0.02
        )  # left part of the previous line's row (RTL)
        new = not same_row and (prev is None or prev_heading or _starts_block(line, text))
        if not new and not same_row and prev is not None:
            short = a is not None and a[0] > block_left + 0.12  # RTL: ended before the left edge
            if (
                prev_text.endswith(_BLOCK_END)
                or (prev_text.endswith(_SOFT_END) and (short or a is None))
                or short
                or a
                and b
                and line.page == prev.page
                and b[1] - a[3] > max(0.01, 1.8 * usual_gap)
            ):
                new = True
        if new:
            paragraphs.append([text])
        else:
            paragraphs[-1].append(text)
        prev, prev_text = line, text
        prev_heading = bool(_is_section_heading(text) or detect_subject_heading(text))
    return "\n".join(normalize_text(" ".join(p)) for p in paragraphs)


def _page_lines(doc: DocumentResult) -> dict[int, list[Line]]:
    by_page: dict[int, list[Line]] = {p.index: [] for p in doc.pages}
    for line in _content_lines(doc):
        by_page.setdefault(line.page, []).append(line)
    return by_page


def document_plain_text(doc: DocumentResult) -> list[str]:
    """Readable text per page (full-text mode), running headers/footers removed."""
    by_page = _page_lines(doc)
    return [_plain_text(by_page.get(p.index, [])) for p in doc.pages]


def page_plain_text(page: PageResult) -> str:
    """Readable text of one page; cross-page header detection needs `document_plain_text`."""
    doc = DocumentResult(kind="booklet", filename="", pages=[page])
    return _plain_text(_page_lines(doc).get(page.index, []))


def detect_mode(result: ParseResult) -> Literal["questions", "text"]:
    """ "questions" when the parse found real multiple-choice questions, else "text"."""
    questions = result.questions
    well_formed = sum(1 for q in questions if sum(1 for o in q.options if o.text.strip()) >= 2)
    if well_formed >= 3 or (questions and well_formed >= 0.5 * len(questions)):
        return "questions"
    return "text"
