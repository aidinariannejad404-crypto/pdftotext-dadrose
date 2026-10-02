"""Shared data contract for the whole service.

Every module (OCR pipeline, parser, API, frontend) speaks these shapes.
Bounding boxes are normalized to the page: [x0, y0, x1, y1] in 0..1, origin
top-left, measured on the *processed* page image (the one shown in the UI).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

BBox = tuple[float, float, float, float]

DocKind = Literal["booklet", "explanations"]
# What the admin uploaded: "auto" lets the system decide after OCR.
DocType = Literal["auto", "questions", "text"]
EngineName = Literal["auto", "offline", "claude", "gemini"]
WordFlag = Literal["low_conf", "disagree"]


# --------------------------------------------------------------------------- OCR


class Word(BaseModel):
    text: str
    bbox: BBox | None = None
    conf: float | None = None  # 0..100; None when the source has no confidence
    flag: WordFlag | None = None  # set when the word needs human attention
    alt: str | None = None  # the other engine's reading when flag == "disagree"


class Line(BaseModel):
    page: int  # 0-based page index inside its document
    words: list[Word]
    bbox: BBox | None = None

    @property
    def text(self) -> str:
        return " ".join(w.text for w in self.words)


class AiUsage(BaseModel):
    """AI cost accounting (tokens as reported by the provider)."""

    calls: int = 0
    cached: int = 0  # answers served from the local AI cache (no cost)
    input_tokens: int = 0
    output_tokens: int = 0

    def add(self, other: AiUsage) -> None:
        self.calls += other.calls
        self.cached += other.cached
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens


class PageResult(BaseModel):
    index: int
    width: int  # processed image size in pixels
    height: int
    source: Literal["text_layer", "ocr"]
    engine: str  # e.g. "text_layer", "tesseract", "claude+tesseract"
    preprocess: list[str] = Field(default_factory=list)  # applied steps, for display
    lines: list[Line] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    # Full-text mode: the admin's corrected text of this page (None = not edited yet).
    edited_text: str | None = None
    approved: bool = False
    # How the AI was used on this page: none | correct (only suspicious lines) | transcribe
    ai_mode: Literal["none", "correct", "transcribe"] = "none"
    quality: float | None = None  # offline OCR quality score 0..1 that drove the decision
    ai_usage: AiUsage = Field(default_factory=AiUsage)


class DocumentResult(BaseModel):
    kind: DocKind
    filename: str
    pages: list[PageResult] = Field(default_factory=list)


# ------------------------------------------------------------------------ Parsed


class Region(BaseModel):
    doc: DocKind
    page: int
    bbox: BBox


class Flag(BaseModel):
    field: str  # "stem" | "option:1".."option:4" | "explanation"
    word: str
    doc: DocKind
    page: int
    bbox: BBox | None = None
    reason: WordFlag
    alt: str | None = None


class Issue(BaseModel):
    level: Literal["error", "warning"]
    code: str  # stable machine code, e.g. "missing_key"
    message: str  # Persian, shown to the admin
    field: str | None = None


ClassSource = Literal["text", "heading", "blueprint", "rules", "ai", "manual", "default"]


class ArticleRef(BaseModel):
    """A law article a question is about, e.g. «بند ۳ ماده‌ی ۲ قانون تجارت»."""

    law_key: str | None = None  # stable key from data/laws.json, e.g. "commercial_code"
    law: str = ""  # display name, e.g. "قانون تجارت"
    kind: Literal["ماده", "اصل"] = "ماده"
    number: str = ""  # "۲", "۱۰ مکرر"
    clause: str = ""  # "بند ۳" / "تبصره ۱"
    source: ClassSource = "text"
    field: str | None = None  # where it was found: stem | option:N | explanation


class Classification(BaseModel):
    subject_source: ClassSource | None = None
    subject_confidence: float | None = None  # 0..1
    topic_source: ClassSource | None = None
    topic_confidence: float | None = None
    section_path: list[str] = Field(default_factory=list)  # book headings above the question


class DuplicateRef(BaseModel):
    """Another question (in this or an earlier project) with the same or very similar text."""

    project_id: str
    project_title: str = ""
    number: int
    similarity: float  # 0..1 (1 = identical after normalization)


class Option(BaseModel):
    key: str  # "1".."4"
    text: str = ""


class Question(BaseModel):
    number: int
    subject_key: str | None = None
    stem: str = ""
    options: list[Option] = Field(default_factory=list)
    correct_key: str | None = None
    key_source: Literal["table", "explanation", "inline", "manual"] | None = None
    explanation: str = ""
    source_ref: str = ""  # e.g. "ارشد سراسری-۷۸" printed next to the question
    topic: str = ""  # مبحث, e.g. "تاجر و اعمال تجارتی"
    articles: list[ArticleRef] = Field(default_factory=list)
    classification: Classification = Field(default_factory=Classification)
    regions: list[Region] = Field(default_factory=list)
    flags: list[Flag] = Field(default_factory=list)
    issues: list[Issue] = Field(default_factory=list)
    status: Literal["pending", "approved"] = "pending"
    approved_by: Literal["admin", "auto"] | None = None
    duplicates: list[DuplicateRef] = Field(default_factory=list)
    edited: bool = False


class ParseResult(BaseModel):
    questions: list[Question] = Field(default_factory=list)
    issues: list[Issue] = Field(default_factory=list)  # document-level issues


# ----------------------------------------------------------------------- Project


class Progress(BaseModel):
    stage: str = "queued"  # queued|rendering|ocr|parsing|done|failed (+ Persian label in UI)
    done: int = 0
    total: int = 0


class ProjectStats(BaseModel):
    pages: int = 0
    started_at: datetime | None = None
    finished_at: datetime | None = None
    ocr_seconds: float = 0.0
    parse_seconds: float = 0.0
    engine: str = ""  # engine actually used, e.g. "claude+tesseract"
    ai_pages: int = 0  # pages where an AI engine was used (correct or transcribe)
    ai_usage: AiUsage = Field(default_factory=AiUsage)
    ai_cost_usd: float = 0.0  # estimate from the configured per-token prices


class DocInfo(BaseModel):
    kind: DocKind
    filename: str
    page_count: int = 0


class Project(BaseModel):
    id: str
    title: str
    track: Literal["bar", "center", "other"] = "other"
    year: int | None = None
    blueprint: str = "auto"  # blueprint code (see app.blueprints) or "auto"
    doc_type: DocType = "auto"  # what the admin chose at upload
    # Subject for questions the blueprint/headings can't place (e.g. a one-subject test book).
    default_subject: str | None = None
    mode: Literal["questions", "text"] = "questions"  # resolved review mode
    engine: EngineName = "auto"
    created_at: datetime
    status: Literal["queued", "processing", "ready", "failed"] = "queued"
    progress: Progress = Field(default_factory=Progress)
    error: str | None = None
    documents: list[DocInfo] = Field(default_factory=list)
    questions: list[Question] = Field(default_factory=list)
    issues: list[Issue] = Field(default_factory=list)
    # Full-text mode progress, keyed "<doc>:<page>" → approved.
    page_status: dict[str, bool] = Field(default_factory=dict)
    batch_id: str | None = None  # projects uploaded together share a batch id
    auto_approve: bool = False  # approve clean questions automatically after parsing
    stats: ProjectStats = Field(default_factory=ProjectStats)


class PageTextUpdate(BaseModel):
    text: str | None = None
    approved: bool | None = None


class ProjectSummary(BaseModel):
    id: str
    title: str
    track: str
    year: int | None
    created_at: datetime
    status: str
    progress: Progress
    error: str | None
    mode: str = "questions"
    page_count: int = 0
    batch_id: str | None = None
    queue_position: int | None = None  # 1-based position while queued
    auto_approved_count: int = 0
    duplicate_count: int = 0
    stats: ProjectStats = Field(default_factory=ProjectStats)
    question_count: int
    approved_count: int
    error_count: int


class QuestionUpdate(BaseModel):
    subject_key: str | None = None
    stem: str | None = None
    options: list[Option] | None = None
    correct_key: str | None = None
    explanation: str | None = None
    source_ref: str | None = None
    topic: str | None = None
    articles: list[ArticleRef] | None = None
    duplicates: list[DuplicateRef] | None = None  # [] = admin confirmed «تکراری نیست»
    status: Literal["pending", "approved"] | None = None
    # the remaining flags after the admin accepted a word or swapped in the alternative reading
    flags: list[Flag] | None = None
