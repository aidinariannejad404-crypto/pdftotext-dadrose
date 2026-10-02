"""Rule-based classification: subject (درس), topic (مبحث) and law articles (مواد/اصول).

Data lives in app/data/laws.json and app/data/taxonomy.json (editable by admins).
Sources are recorded in `Question.classification`; anything marked "manual" is never
overwritten.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .blueprints import SUBJECT_KEYS, detect_subject_heading, subject_for
from .models import ArticleRef, ClassSource, Question
from .normalize import ZWNJ, comparable, normalize_text, to_ascii_digits, to_persian_digits

DATA_DIR = Path(__file__).parent / "data"
FIELD_WEIGHT = {"stem": 2.0, "explanation": 1.0}  # options: 1.5


# --------------------------------------------------------------------------- data


@dataclass(frozen=True)
class Law:
    key: str
    name: str
    aliases: tuple[str, ...]
    subject_key: str | None
    kind: str


@dataclass(frozen=True)
class Topic:
    subject_key: str
    name: str
    keywords: tuple[str, ...]
    law_key: str | None
    ranges: tuple[tuple[int, int], ...]
    unverified: bool


@lru_cache(maxsize=1)
def load_laws() -> dict[str, Law]:
    data = json.loads((DATA_DIR / "laws.json").read_text("utf-8"))
    return {
        item["key"]: Law(
            key=item["key"],
            name=item["name"],
            aliases=tuple(item.get("aliases", [])),
            subject_key=item.get("subject_key"),
            kind=item.get("kind", "ماده"),
        )
        for item in data["laws"]
    }


@lru_cache(maxsize=1)
def load_taxonomy() -> dict:
    return json.loads((DATA_DIR / "taxonomy.json").read_text("utf-8"))


@lru_cache(maxsize=1)
def topics_by_subject() -> dict[str, list[Topic]]:
    out: dict[str, list[Topic]] = {}
    for subject, spec in load_taxonomy()["subjects"].items():
        main_law = spec.get("main_law")
        out[subject] = [
            Topic(
                subject_key=subject,
                name=t["name"],
                keywords=tuple(t.get("keywords", [])),
                law_key=t.get("law_key", main_law),
                ranges=tuple((int(a), int(b)) for a, b in t.get("ranges", [])),
                unverified=bool(t.get("unverified")),
            )
            for t in spec.get("topics", [])
        ]
    return out


def main_law_for(subject_key: str | None) -> str | None:
    if not subject_key:
        return None
    spec = load_taxonomy()["subjects"].get(subject_key)
    return spec.get("main_law") if spec else None


def taxonomy_for_api() -> dict[str, list[str]]:
    return {s: [t.name for t in topics] for s, topics in topics_by_subject().items()}


def laws_for_api() -> list[dict]:
    return [
        {"key": law.key, "name": law.name, "subject_key": law.subject_key}
        for law in load_laws().values()
    ]


def law_key_for_name(name: str) -> str | None:
    """Resolve a law name/abbreviation (as written in a text or by an AI) to its key."""
    target = _alias_form(name)
    if not target:
        return None
    for alias, key in _alias_table():
        if _alias_form(alias) == target:
            return key
    return None


# ------------------------------------------------------------------- articles

_REFERENCE_WORDS = (
    "همان قانون",
    "همین قانون",
    "قانون مذکور",
    "قانون فوق",
    "قانون فوق‌الذکر",
    "قانون یادشده",
    "قانون یاد شده",
    "قانون مزبور",
    "قانون اخیر",
    "قانون اخیرالذکر",
    "این قانون",
)
_STOP_WORDS = {
    "ماده",
    "مواد",
    "اصل",
    "بند",
    "تبصره",
    "که",
    "در",
    "به",
    "را",
    "با",
    "است",
    "بر",
    "تا",
    "یا",
    "این",
    "آن",
    "هر",
    "نیز",
    "اما",
    "ولی",
    "چنین",
    "شده",
    "باشد",
    "کرده",
    "مقرر",
    "بیان",
    "طبق",
    "مطابق",
}
_ARTICLE = re.compile(
    r"(?:(?P<clause>بند|تبصره|جزء|قسمت)\s*[«\"(]?\s*(?P<clause_id>\d{1,3}|[آ-ی]{1,3})\s*[»\")]?"
    r"\s+(?:(?:از|ذیل|الحاقی\s+به)\s+)?)?"
    r"(?P<kind>ماده|مواد|اصل|اصول)(?:" + ZWNJ + r"?ی)?\s+"
    r"(?P<nums>واحده|\d{1,4}(?:\s*مکرر(?:\s*\d{1,2})?)?"
    r"(?:\s*(?:،|,|و|تا|الی|-|–)\s*\d{1,4}(?:\s*مکرر(?:\s*\d{1,2})?)?)*)"
)
_NUM = re.compile(r"(\d{1,4})(\s*مکرر(?:\s*\d{1,2})?)?")


def _alias_form(text: str) -> str:
    """Comparison form for law names: no dots/ZWNJ/extra spaces, ascii digits."""
    return " ".join(comparable(text.replace(".", " ")).split())


@lru_cache(maxsize=1)
def _alias_table() -> list[tuple[str, str]]:
    pairs = [(law.name, law.key) for law in load_laws().values()]
    pairs += [(a, law.key) for law in load_laws().values() for a in law.aliases]
    # longest first so "قانون تجارت الکترونیکی" wins over "قانون تجارت", "ق.م.ا" over "ق.م"
    return sorted(pairs, key=lambda p: len(_alias_form(p[0])), reverse=True)


_FOLD_CLASSES = {"ا": "[اآأإٱ]", "ی": "[یئ]", "و": "[وؤ]", "ه": "[هةۀ]"}


def _fold_pattern(word: str) -> str:
    """Regex for a comparable()-folded word that also matches the unfolded spellings."""
    return "\u200c?".join(_FOLD_CLASSES.get(ch, re.escape(ch)) for ch in word)


@lru_cache(maxsize=1)
def _alias_regex() -> re.Pattern[str]:
    parts = []
    for alias, _ in _alias_table():
        words = _alias_form(alias).split()
        if not words:
            continue
        abbreviation = all(len(w) == 1 for w in words)
        sep = r"[.\s]+" if abbreviation else r"[\s‌]*"
        body = sep.join(_fold_pattern(w) for w in words)
        parts.append(body + (r"\.?" if abbreviation else ""))
    refs = "|".join(re.escape(r).replace(r"\ ", r"[\s‌]*") for r in _REFERENCE_WORDS)
    return re.compile(rf"^(?:(?:از|در)\s+)?(?:(?P<ref>{refs})|(?P<law>{'|'.join(parts)}))(?![\w])")


def _prepare(text: str) -> str:
    # normalize + ascii digits; "ي/ك" and diacritics handled by comparable-like folding
    s = to_ascii_digits(normalize_text(text)).replace("\n", " ")
    return s.replace("ؤ", "و").replace("ئ", "ی").replace("أ", "ا").replace("إ", "ا")


def _law_after(text: str) -> tuple[str | None, str, bool]:
    """(law_key, law display text, is_back_reference) for the words after an article."""
    m = _alias_regex().match(text)
    if m:
        if m.group("ref"):
            return None, "", True
        written = m.group("law")
        key = law_key_for_name(written)
        return key, load_laws()[key].name if key else written, False
    # an unknown law: "قانون <words>" up to punctuation or a stop word
    m = re.match(r"^(?:(?:از|در)\s+)?قانون((?:\s+[^\s،,.؛:()«»]+){1,6})", text)
    if m:
        words = []
        for w in m.group(1).split():
            if w in _STOP_WORDS or w.startswith("می" + ZWNJ):
                break
            words.append(w)
        if words:
            return None, "قانون " + " ".join(words), False
    return None, "", False


def _expand_numbers(nums: str) -> list[str]:
    if nums == "واحده":
        return ["واحده"]
    tokens = re.findall(r"\d{1,4}(?:\s*مکرر(?:\s*\d{1,2})?)?|تا|الی|-|–", nums)
    out: list[str] = []
    pending_range = False
    for tok in tokens:
        if tok in ("تا", "الی", "-", "–"):
            pending_range = True
            continue
        m = _NUM.fullmatch(tok)
        if not m:
            continue
        number = m.group(1) + (" مکرر" + re.sub(r"\D", "", m.group(2)) if m.group(2) else "")
        number = number.strip()
        if pending_range and out and out[-1].isdigit() and number.isdigit():
            start, end = int(out[-1]), int(number)
            if 0 < end - start <= 30:
                out.extend(str(n) for n in range(start + 1, end + 1))
            else:
                out.append(number)
        else:
            out.append(number)
        pending_range = False
    return out


def _display_number(number: str) -> str:
    return to_persian_digits(number.replace("مکرر", " مکرر")).replace("  ", " ").strip()


def extract_articles(
    text: str, field: str | None = None, context_law_key: str | None = None
) -> list[ArticleRef]:
    """Law articles cited in `text` («ماده‌ی ۲ قانون تجارت»، «مواد ۱۰ و ۱۱ ق.م»، «اصل ۴۹»).

    Refs without a law name use the last law named earlier in the text, then
    `context_law_key`; those get source "rules" (inferred) instead of "text".
    «اصل» without a law means the constitution.
    """
    s = _prepare(text)
    laws = load_laws()
    refs: list[ArticleRef] = []
    seen: set[tuple] = set()
    previous: str | None = None
    for m in _ARTICLE.finditer(s):
        if m.start() and re.match(r"\w", s[m.start() - 1]):
            continue  # inside a word
        kind = "اصل" if m.group("kind") in ("اصل", "اصول") else "ماده"
        law_key, law_name, back_ref = _law_after(s[m.end() :].lstrip())
        source: ClassSource = "text"
        if back_ref or not law_name:
            if back_ref and previous:
                law_key = previous
            elif kind == "اصل" and not back_ref:
                law_key = "constitution"
            elif previous:
                law_key, source = previous, "rules"
            elif context_law_key:
                law_key, source = context_law_key, "rules"
            else:
                continue  # a bare article number with no law: not useful
            law_name = laws[law_key].name if law_key in laws else ""
        if law_key:
            previous = law_key
        clause = ""
        if m.group("clause"):
            clause_id = m.group("clause_id")
            clause = f"{m.group('clause')} {to_persian_digits(clause_id)}"
        for number in _expand_numbers(m.group("nums")):
            ref = ArticleRef(
                law_key=law_key,
                law=law_name,
                kind=kind,  # type: ignore[arg-type]
                number=_display_number(number),
                clause=clause,
                source=source,
                field=field,
            )
            key = (ref.law_key or ref.law, ref.kind, ref.number, ref.clause)
            if key not in seen:
                seen.add(key)
                refs.append(ref)
    return refs


def _question_fields(q: Question) -> list[tuple[str, str]]:
    fields = [("stem", q.stem)]
    fields += [(f"option:{o.key}", o.text) for o in q.options]
    fields.append(("explanation", q.explanation))
    return [(f, t) for f, t in fields if t]


def question_articles(q: Question, context_law_key: str | None) -> list[ArticleRef]:
    refs: list[ArticleRef] = []
    seen: set[tuple] = set()
    # a law named anywhere in the question is better context than the subject's main law
    explicit = [
        r.law_key
        for f, t in _question_fields(q)
        for r in extract_articles(t, f)
        if r.law_key and r.source == "text"
    ]
    context = explicit[0] if explicit else context_law_key
    for field_name, text in _question_fields(q):
        for ref in extract_articles(text, field_name, context):
            key = (ref.law_key or ref.law, ref.kind, ref.number, ref.clause)
            if key not in seen:
                seen.add(key)
                refs.append(ref)
    return refs


def _weight(field_name: str | None) -> float:
    if field_name and field_name.startswith("option:"):
        return 1.5
    return FIELD_WEIGHT.get(field_name or "", 1.0)


def primary_article(q: Question) -> ArticleRef | None:
    """The most relevant article (explicit over inferred; stem > options > explanation)."""
    if not q.articles:
        return None
    rank = {"manual": 0, "text": 1, "ai": 2, "rules": 3}
    order = {ref_id: i for i, ref_id in enumerate(map(id, q.articles))}
    return min(
        q.articles,
        key=lambda r: (rank.get(r.source, 4), -_weight(r.field), order[id(r)]),
    )


def format_article(ref: ArticleRef) -> str:
    """ "۲ قانون تجارت" (number + law), as the site's «ماده:» meta line expects."""
    return " ".join(p for p in (ref.number, ref.law) if p)


# --------------------------------------------------------------------- topics


def _keyword_score(keyword: str, texts: list[tuple[str, str]]) -> float:
    kw = comparable(keyword)
    if not kw:
        return 0.0
    pattern = re.compile(rf"(?<!\w){re.escape(kw)}(?!\w)")
    base = 2.0 if " " in kw else (0.5 if len(kw) <= 3 else 1.0)
    return sum(base * _weight(f) for f, t in texts if pattern.search(t))


def _comparable_fields(q: Question) -> list[tuple[str, str]]:
    return [(f, comparable(t)) for f, t in _question_fields(q)]


def _topic_scores(texts: list[tuple[str, str]], topics: list[Topic]) -> list[tuple[float, Topic]]:
    scored = []
    for topic in topics:
        score = sum(_keyword_score(k, texts) for k in topic.keywords)
        if score:
            scored.append((score, topic))
    return sorted(scored, key=lambda x: -x[0])


def _article_number(ref: ArticleRef) -> int | None:
    m = re.match(r"\d+", to_ascii_digits(ref.number))
    return int(m.group()) if m else None


def _topic_from_articles(refs: list[ArticleRef], topics: list[Topic]) -> tuple[Topic, float] | None:
    votes: dict[str, float] = {}
    best: dict[str, Topic] = {}
    for ref in refs:
        number = _article_number(ref)
        if number is None or not ref.law_key:
            continue
        matches = [
            (b - a, t)
            for t in topics
            if t.law_key == ref.law_key
            for a, b in (t.ranges or ((1, 100000),))
            if a <= number <= b
        ]
        if not matches:
            continue
        _, topic = min(matches, key=lambda x: x[0])  # most specific range wins
        weight = _weight(ref.field) * (1.0 if ref.source == "text" else 0.6)
        votes[topic.name] = votes.get(topic.name, 0.0) + weight
        best[topic.name] = topic
    if not votes:
        return None
    name = max(votes, key=lambda n: votes[n])
    topic = best[name]
    return topic, (0.65 if topic.unverified else 0.85)


_HEADING_PREFIX = re.compile(r"^(بخش|فصل|مبحث|گفتار|قسمت|باب|درس|مقدمه)(\s+[^\s:]+){0,2}\s*:\s*")


def heading_title(heading: str) -> str:
    """ "فصل نخست: تعریف تاجر" -> "تعریف تاجر"."""
    return normalize_text(_HEADING_PREFIX.sub("", normalize_text(heading))).strip(" .:؛")


def _topic_from_heading(path: list[str], topics: list[Topic]) -> tuple[str, float] | None:
    for heading in reversed(path):
        if detect_subject_heading(heading):
            continue
        title = heading_title(heading)
        if not title:
            continue
        ctitle = comparable(title)
        words = set(ctitle.split())
        for topic in topics:
            cname = comparable(topic.name)
            if cname == ctitle or cname in ctitle or (len(ctitle) > 4 and ctitle in cname):
                return topic.name, 0.9
            name_words = {w for w in cname.split() if len(w) > 2 and w != "و"}
            if name_words and len(name_words & words) >= max(1, len(name_words) - 1):
                return topic.name, 0.85
        for topic in topics:
            if any(_keyword_score(k, [("stem", ctitle)]) >= 2 for k in topic.keywords):
                return topic.name, 0.8
        # a book chapter that matches no taxonomy topic is still the best topic we have
        return title, 0.7
    return None


# -------------------------------------------------------------------- subject


def _subject_from_articles(refs: list[ArticleRef]) -> tuple[str, float] | None:
    laws = load_laws()
    votes: Counter[str] = Counter()
    for ref in refs:
        if ref.source != "text" or ref.law_key not in laws:
            continue
        subject = laws[ref.law_key].subject_key
        if subject:
            votes[subject] += _weight(ref.field)
    if not votes:
        return None
    subject, score = votes.most_common(1)[0]
    return subject, round(0.6 + 0.3 * score / sum(votes.values()), 2)


def _subject_from_keywords(texts: list[tuple[str, str]]) -> tuple[str, float] | None:
    per_subject: dict[str, float] = {}
    for subject, topics in topics_by_subject().items():
        scored = _topic_scores(texts, topics)
        if scored:
            per_subject[subject] = scored[0][0] + 0.25 * sum(s for s, _ in scored[1:])
    if not per_subject:
        return None
    ranked = sorted(per_subject.items(), key=lambda x: -x[1])
    best, score = ranked[0]
    runner = ranked[1][1] if len(ranked) > 1 else 0.0
    if score < 2 or score < 1.5 * runner:
        return None
    return best, 0.5


# ------------------------------------------------------------------------ API


def classify_question(
    q: Question,
    *,
    blueprint: str | None = None,
    default_subject: str | None = None,
    section_path: list[str] | None = None,
    doc_subject_hint: str | None = None,
) -> None:
    """Fill subject_key, topic, articles and classification (sources, confidences)."""
    c = q.classification
    if section_path is not None:
        c.section_path = list(section_path)
    path = c.section_path

    # ---- subject
    if c.subject_source != "manual":
        subject: tuple[str, float, ClassSource] | None = None
        bp_subject = subject_for(blueprint, q.number) if blueprint else None
        if bp_subject:
            subject = (bp_subject, 1.0, "blueprint")
        if subject is None:
            explicit = question_articles(q, None)
            if found := _subject_from_articles(explicit):
                subject = (found[0], found[1], "text")
        if subject is None:
            for heading in reversed(path):
                if found_key := detect_subject_heading(heading):
                    subject = (found_key, 0.8, "heading")
                    break
        if subject is None and (found := _subject_from_keywords(_comparable_fields(q))):
            subject = (found[0], found[1], "rules")
        if subject is None and doc_subject_hint in SUBJECT_KEYS:
            subject = (doc_subject_hint, 0.45, "rules")
        if subject is None and default_subject in SUBJECT_KEYS:
            subject = (default_subject, 0.5, "default")
        if subject is not None:
            q.subject_key, c.subject_confidence, c.subject_source = subject
        elif q.subject_key and c.subject_source is None:  # set by the parser / older data
            c.subject_source, c.subject_confidence = "heading", 0.6
        elif c.subject_source != "ai":  # an AI answer survives a rules pass that finds nothing
            q.subject_key, c.subject_source, c.subject_confidence = None, None, None

    # ---- articles (keep manual ones untouched)
    if not any(r.source == "manual" for r in q.articles):
        q.articles = question_articles(q, main_law_for(q.subject_key))

    # ---- topic
    if c.topic_source != "manual":
        topics = topics_by_subject().get(q.subject_key or "", [])
        topic: tuple[str, float, ClassSource] | None = None
        if found_h := _topic_from_heading(path, topics):
            topic = (found_h[0], found_h[1], "heading")
        if topic is None and topics and (found_a := _topic_from_articles(q.articles, topics)):
            topic = (found_a[0].name, found_a[1], "rules")
        if topic is None and topics:
            scored = _topic_scores(_comparable_fields(q), topics)
            if scored and scored[0][0] >= 2 and (len(scored) == 1 or scored[0][0] > scored[1][0]):
                confidence = min(0.75, 0.35 + 0.05 * scored[0][0])
                topic = (scored[0][1].name, round(confidence, 2), "rules")
        if topic is not None:
            q.topic, c.topic_confidence, c.topic_source = topic
        elif c.topic_source != "ai":
            q.topic, c.topic_confidence, c.topic_source = "", None, None


_CONFIDENT = {"blueprint", "text", "heading", "manual", "ai"}


def classify_project(
    questions: list[Question],
    *,
    blueprint: str | None = None,
    default_subject: str | None = None,
) -> None:
    """Classify all questions; the document's dominant subject helps weak cases."""
    for q in questions:
        classify_question(q, blueprint=blueprint, default_subject=default_subject)
    votes = Counter(
        q.subject_key
        for q in questions
        if q.subject_key and q.classification.subject_source in _CONFIDENT
    )
    if not votes:
        return
    hint, count = votes.most_common(1)[0]
    if count < max(2, 0.6 * sum(votes.values())):
        return
    for q in questions:
        if q.classification.subject_source in (None, "default"):
            classify_question(
                q, blueprint=blueprint, default_subject=default_subject, doc_subject_hint=hint
            )
