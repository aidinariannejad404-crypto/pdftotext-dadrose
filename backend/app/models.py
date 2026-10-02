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


class PageResult(BaseModel):
    index: int
    width: int  # processed image size in pixels
    height: int
    source: Literal["text_layer", "ocr"]
    engine: str  # e.g. "text_layer", "tesseract", "claude+tesseract"
    preprocess: list[str] = Field(default_factory=list)  # applied steps, for display
    lines: list[Line] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


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


class Option(BaseModel):
    key: str  # "1".."4"
    text: str = ""


class Question(BaseModel):
    number: int
    subject_key: str | None = None
    stem: str = ""
    options: list[Option] = Field(default_factory=list)
    correct_key: str | None = None
    key_source: Literal["table", "explanation", "manual"] | None = None
    explanation: str = ""
    regions: list[Region] = Field(default_factory=list)
    flags: list[Flag] = Field(default_factory=list)
    issues: list[Issue] = Field(default_factory=list)
    status: Literal["pending", "approved"] = "pending"
    edited: bool = False


class ParseResult(BaseModel):
    questions: list[Question] = Field(default_factory=list)
    issues: list[Issue] = Field(default_factory=list)  # document-level issues


# ----------------------------------------------------------------------- Project


class Progress(BaseModel):
    stage: str = "queued"  # queued|rendering|ocr|parsing|done|failed (+ Persian label in UI)
    done: int = 0
    total: int = 0


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
    engine: EngineName = "auto"
    created_at: datetime
    status: Literal["queued", "processing", "ready", "failed"] = "queued"
    progress: Progress = Field(default_factory=Progress)
    error: str | None = None
    documents: list[DocInfo] = Field(default_factory=list)
    questions: list[Question] = Field(default_factory=list)
    issues: list[Issue] = Field(default_factory=list)


class ProjectSummary(BaseModel):
    id: str
    title: str
    track: str
    year: int | None
    created_at: datetime
    status: str
    progress: Progress
    error: str | None
    question_count: int
    approved_count: int
    error_count: int


class QuestionUpdate(BaseModel):
    subject_key: str | None = None
    stem: str | None = None
    options: list[Option] | None = None
    correct_key: str | None = None
    explanation: str | None = None
    status: Literal["pending", "approved"] | None = None
