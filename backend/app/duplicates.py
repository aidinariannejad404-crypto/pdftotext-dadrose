"""Duplicate / near-duplicate question detection across projects.

Approach: each question becomes a normalized fingerprint (stem + options sorted, via
`comparable()`: digit styles, ZWNJ, punctuation, ی/ي ک/ك and diacritics folded,
option/item markers dropped). Similarity is the Dice coefficient of character
3-gram sets, which tolerates OCR noise and small edits.

To avoid comparing every pair, candidates come from MinHash + LSH banding
(numpy-vectorized): 40 hash functions in 10 bands of 4 rows. Two questions with
Dice >= 0.88 (Jaccard >= 0.79) share a band with probability ~99%; identical
fingerprints always match. Only candidates get the exact Dice check, so 5,000
existing x 140 new questions take about a second. Candidates whose MinHash-estimated
Jaccard is far below the threshold are dropped before the exact check.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

import numpy as np

from .models import DuplicateRef, Project, Question
from .normalize import comparable

MIN_LENGTH = 25  # shorter fingerprints (e.g. empty stems) are never reported
TOP_N = 3
_MARKERS = {"الف", "ب", "ج", "د"}
_LEADING_NUMBER = re.compile(r"^\d{1,3}\s+")


def _clean(text: str) -> str:
    words = [w for w in comparable(text).split() if w not in _MARKERS]
    return " ".join(words)


def question_fingerprint(q: Question) -> str:
    stem = _LEADING_NUMBER.sub("", _clean(q.stem))
    options = sorted(_clean(o.text) for o in q.options if o.text.strip())
    return " | ".join([stem, *options]).strip(" |")


def _shingles(fingerprint: str) -> frozenset[str]:
    s = fingerprint.replace(" | ", " ")
    if len(s) < 3:
        return frozenset([s]) if s else frozenset()
    return frozenset(s[i : i + 3] for i in range(len(s) - 2))


def _dice(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    return 2 * len(a & b) / (len(a) + len(b))


def similarity(a: Question, b: Question) -> float:
    """0..1 (1 = identical after normalization)."""
    fa, fb = question_fingerprint(a), question_fingerprint(b)
    if fa == fb:
        return 1.0 if fa else 0.0
    return round(_dice(_shingles(fa), _shingles(fb)), 4)


@dataclass(eq=False)
class _Doc:
    project_id: str
    project_title: str
    question: Question
    fingerprint: str
    shingles: frozenset[str]


def _docs(project: Project) -> list[_Doc]:
    out = []
    for q in project.questions:
        fp = question_fingerprint(q)
        if len(fp) >= MIN_LENGTH:
            out.append(_Doc(project.id, project.title, q, fp, _shingles(fp)))
    return out


_PRIME = 4294967311  # > 2**32
_BANDS, _ROWS = 10, 4
_rng = np.random.default_rng(20261002)
_A = _rng.integers(1, 2**31, size=_BANDS * _ROWS, dtype=np.uint64)
_B = _rng.integers(0, 2**31, size=_BANDS * _ROWS, dtype=np.uint64)


def _signatures(docs: list[_Doc]) -> np.ndarray:
    """MinHash signatures, shape (len(docs), BANDS * ROWS)."""
    lengths = np.fromiter((len(d.shingles) for d in docs), dtype=np.int64, count=len(docs))
    offsets = np.concatenate(([0], np.cumsum(lengths)[:-1]))
    hashes = np.fromiter(
        (hash(s) & 0xFFFFFFFF for d in docs for s in d.shingles),
        dtype=np.uint64,
        count=int(lengths.sum()),
    )
    sig = np.empty((len(docs), _BANDS * _ROWS), dtype=np.uint64)
    for k in range(_BANDS * _ROWS):
        sig[:, k] = np.minimum.reduceat((_A[k] * hashes + _B[k]) % _PRIME, offsets)
    return sig


def _candidates(docs: list[_Doc], n_new: int, threshold: float) -> dict[int, list[int]]:
    sig = _signatures(docs)
    out: dict[int, set[int]] = defaultdict(set)
    for band in range(_BANDS):
        block = np.ascontiguousarray(sig[:, band * _ROWS : (band + 1) * _ROWS])
        buckets: dict[bytes, list[int]] = defaultdict(list)
        for i in range(len(docs)):
            buckets[block[i].tobytes()].append(i)
        for members in buckets.values():
            if len(members) > 1 and members[0] < n_new:  # new docs come first
                for i in members:
                    if i >= n_new:
                        break
                    out[i].update(members)
    by_fingerprint: dict[str, list[int]] = defaultdict(list)
    for i, d in enumerate(docs):
        by_fingerprint[d.fingerprint].append(i)
    # Drop candidates whose estimated Jaccard (share of equal MinHash values) is far
    # below the threshold; the margin is ~3 standard deviations of the estimate.
    min_estimate = threshold / (2 - threshold) - 0.2
    result: dict[int, list[int]] = {}
    for i in range(n_new):
        cands = np.fromiter(out.get(i, ()), dtype=np.int64)
        if len(cands):
            estimate = (sig[cands] == sig[i]).mean(axis=1)
            cands = cands[estimate >= min_estimate]
        result[i] = sorted(set(cands.tolist()) | set(by_fingerprint[docs[i].fingerprint]))
    return result


def find_duplicates(project: Project, others: list[Project], threshold: float = 0.88) -> None:
    """Fill `q.duplicates` (top 3) for every question of `project`.

    Compared against the other questions of the same project and all questions (any
    status) of `others`. Only question-mode projects take part.
    """
    for q in project.questions:
        q.duplicates = []
    if project.mode != "questions":
        return
    new_docs = _docs(project)
    if not new_docs:
        return
    old_docs = [d for p in others if p.mode == "questions" and p.id != project.id for d in _docs(p)]
    docs = new_docs + old_docs
    n_new = len(new_docs)
    found: dict[int, dict[int, float]] = defaultdict(dict)
    for i, candidates in _candidates(docs, n_new, threshold).items():
        d = docs[i]
        for j in candidates:
            if j == i or j in found[i]:
                continue
            other = docs[j]
            sim = 1.0 if d.fingerprint == other.fingerprint else _dice(d.shingles, other.shingles)
            if sim >= threshold:
                found[i][j] = sim
                if j < n_new:
                    found[j][i] = sim

    for i, matches in found.items():
        best = sorted(matches.items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_N]
        new_docs[i].question.duplicates = [
            DuplicateRef(
                project_id=docs[j].project_id,
                project_title=docs[j].project_title,
                number=docs[j].question.number,
                similarity=round(sim, 4),
            )
            for j, sim in best
        ]
