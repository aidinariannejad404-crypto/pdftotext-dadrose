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

from .blueprints import detect_subject_heading, get_blueprint, subject_for
from .models import (
    BBox,
    DocKind,
    DocumentResult,
    Flag,
    Issue,
    Line,
    Option,
    ParseResult,
    Question,
    Region,
    Word,
)
from .normalize import ZWNJ, comparable, normalize_text, to_ascii_digits, to_persian_digits
from .validate import stated_key, validate_project, validate_question

QUESTION_GAP = 5  # max numbers a question marker may skip (missing questions)
EXPLANATION_GAP = 10
LOOKAHEAD_TOKENS = 300
LETTERS = {"الف": 1, "ب": 2, "ج": 3, "د": 4}

_DELIMS = r")(\]\[.\-–—ـ:_"
_CORE = r"\d{1,3}|الف|ب|ج|د"
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
    heading: str | None = None  # a whole subject-heading line collapsed into one token


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
    m = _MARK.match(t.text)
    if m:
        lead, core, trail = m.groups()
        size = 1
        delims = trail or lead
        if not delims and nxt is not None and _PURE_DELIM.match(nxt.text):
            delims, size = nxt.text, 2  # "۱۲" "-" split into two words
        kind = "letter" if core in LETTERS else "digit"
        value = LETTERS.get(core) or int(to_ascii_digits(core))
        if value == 0:
            return None
        if not delims:
            if kind == "letter" or not allow_bare:
                return None
            return _Marker(value, kind, "", size, t.first)
        return _Marker(value, kind, _style_of(delims[0]), size, t.first)
    # "(" "۱" / "-" "۱۲" split at line start (RTL extraction artifact)
    if t.first and _PURE_DELIM.match(t.text) and nxt is not None and _CORE_ONLY.match(nxt.text):
        kind = "letter" if nxt.text in LETTERS else "digit"
        value = LETTERS.get(nxt.text) or int(to_ascii_digits(nxt.text))
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


def _noise_lines(doc: DocumentResult) -> set[int]:
    """ids of Line objects that are headers/footers/page numbers/watermarks."""
    noise: set[int] = set()
    edge_texts: dict[str, set[int]] = {}
    for page in doc.pages:
        lines = [ln for ln in page.lines if ln.words]
        for idx, line in enumerate(lines):
            text = to_ascii_digits(normalize_text(line.text))
            at_edge = idx < 2 or idx >= len(lines) - 2
            if any(p.search(text) for p in _ALWAYS_NOISE) or at_edge and _PAGE_NUMBER.match(text):
                noise.add(id(line))
            elif (idx < 3 or idx >= len(lines) - 3) and not detect_subject_heading(text):
                toks = _line_tokens(line)
                if toks and _marker_at(toks, 0) is None:
                    key = re.sub(r"\d+", "", comparable(text)).strip()
                    if key:
                        edge_texts.setdefault(key, set()).add(page.index)
    repeated = {k for k, pages in edge_texts.items() if len(pages) >= max(3, 0.3 * len(doc.pages))}
    if repeated:
        for page in doc.pages:
            for line in page.lines:
                if re.sub(r"\d+", "", comparable(line.text)).strip() in repeated:
                    noise.add(id(line))
    return noise


def _content_lines(doc: DocumentResult) -> list[Line]:
    noise = _noise_lines(doc)
    return [ln for page in doc.pages for ln in page.lines if ln.words and id(ln) not in noise]


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
    field: str = "stem"


class _BookletParser:
    def __init__(self, toks: list[_Tok], single: bool = False) -> None:
        self.toks = toks
        self.single = single
        self.subject: str | None = None
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
                self.subject = t.heading
                i += 1
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
                self.cur.fields[self.cur.field].append(t)
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
            )
        if m.value == 1 and m.first and all(q.nopts == 0 for q in self.questions):
            return True  # numbered instructions before the real first question: restart
        expected = cur.number + 1
        if not expected <= m.value <= expected + QUESTION_GAP:
            return False
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
        if cur is None or cur.nopts >= 4 or m.value != cur.nopts + 1:
            return False
        if m.style == "" and (self.o_sig is None or self.o_sig[1] != ""):
            return False
        if m.value == 1:
            if not m.first and _guarded(self.toks, i):
                return False
            if self.o_sig and m.sig != self.o_sig:
                # e.g. stem items "الف) ... ب)" followed by the real "۱) ... ۲)" options
                if self._sequence_ahead(i + m.size, self.o_sig, 1):
                    return False
                return self._sequence_ahead(i + m.size, m.sig, 2)
            if not m.first:
                return self._sequence_ahead(i + m.size, m.sig, 2)
            return True
        assert cur.opt_sig is not None
        if m.kind != cur.opt_sig[0]:
            return False
        if m.first:
            return m.style == cur.opt_sig[1] or not _guarded(self.toks, i)
        return m.style == cur.opt_sig[1] and not _guarded(self.toks, i)

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
        if self.cur is not None and m.value == 1 and all(q.nopts == 0 for q in self.questions):
            self.questions.clear()
        self.cur = _Build(number=m.value, subject=self.subject)
        self.cur.marker_toks["stem"] = markers
        self.questions.append(self.cur)

    def _start_option(self, m: _Marker, i: int) -> None:
        cur = self.cur
        assert cur is not None
        cur.nopts += 1
        if cur.nopts == 1:
            cur.opt_sig = m.sig
        cur.field = f"option:{cur.nopts}"
        cur.fields[cur.field] = []
        cur.marker_toks[cur.field] = self.toks[i : i + m.size]


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
    return Question(
        number=b.number,
        subject_key=b.subject,
        stem=_join(b.fields["stem"]),
        options=options,
        flags=flags,
        regions=_regions(all_toks, "booklet"),
    )


def _tokenize(lines: list[Line], headings: bool) -> list[_Tok]:
    toks: list[_Tok] = []
    for line in lines:
        line_toks = _line_tokens(line)
        if not line_toks:
            continue
        subject = detect_subject_heading(line.text) if headings else None
        if subject and _marker_at(line_toks, 0) is None:
            toks.append(_Tok("", line.words[0], line, first=True, heading=subject))
            continue
        toks.extend(line_toks)
    return toks


# ------------------------------------------------------------------------- API


def build_questions(
    booklet: DocumentResult, explanations: DocumentResult | None, blueprint: str
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
        if q.number in key:
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
