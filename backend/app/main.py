"""HTTP API + static review UI."""

from __future__ import annotations

import base64
import secrets
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal

import pymupdf
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import get_settings
from .jobs import JobRunner
from .models import (
    DocInfo,
    DocKind,
    EngineName,
    PageResult,
    Project,
    ProjectSummary,
    Question,
    QuestionUpdate,
)
from .store import ProjectNotFound, Store

MAX_UPLOAD_BYTES = 200 * 1024 * 1024
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"

settings = get_settings()
store = Store(settings.data_dir)
jobs = JobRunner(store, settings)


@asynccontextmanager
async def lifespan(_: FastAPI):
    jobs.resume_pending()
    yield
    jobs.shutdown()


app = FastAPI(title="DADROSE PDF → Text", lifespan=lifespan)


@app.middleware("http")
async def basic_auth(request: Request, call_next):
    if settings.admin_password and request.url.path != "/api/health":
        header = request.headers.get("authorization", "")
        password = ""
        if header.lower().startswith("basic "):
            try:
                password = base64.b64decode(header[6:]).decode().partition(":")[2]
            except ValueError:
                password = ""
        if not secrets.compare_digest(password.encode(), settings.admin_password.encode()):
            return Response(
                status_code=401,
                headers={"WWW-Authenticate": 'Basic realm="dadrose-ocr", charset="UTF-8"'},
            )
    return await call_next(request)


@app.exception_handler(ProjectNotFound)
async def not_found(_: Request, __: ProjectNotFound):
    return JSONResponse({"detail": "پروژه پیدا نشد."}, status_code=404)


# ---------------------------------------------------------------------- helpers


def _load(project_id: str) -> Project:
    return store.load(project_id)


def _has_explanations(project: Project) -> bool:
    return any(d.kind == "explanations" for d in project.documents)


def _find(project: Project, number: int) -> Question:
    for question in project.questions:
        if question.number == number:
            return question
    raise HTTPException(404, "سؤال پیدا نشد.")


def _revalidate(project: Project) -> None:
    from .blueprints import BLUEPRINTS
    from .validate import validate_project, validate_question

    has_expl = _has_explanations(project)
    for question in project.questions:
        question.issues = validate_question(question, has_expl)
    expected = next(
        (b["question_count"] for b in BLUEPRINTS if b["code"] == project.blueprint), None
    )
    project.issues = validate_project(project.questions, has_expl, expected)


def _summary(project: Project) -> ProjectSummary:
    return ProjectSummary(
        id=project.id,
        title=project.title,
        track=project.track,
        year=project.year,
        created_at=project.created_at,
        status=project.status,
        progress=project.progress,
        error=project.error,
        question_count=len(project.questions),
        approved_count=sum(q.status == "approved" for q in project.questions),
        error_count=sum(any(i.level == "error" for i in q.issues) for q in project.questions),
    )


async def _read_pdf(upload: UploadFile) -> tuple[bytes, int]:
    data = await upload.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "حجم فایل بیش از حد مجاز است (۲۰۰ مگابایت).")
    try:
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            pages = doc.page_count
    except Exception as exc:
        raise HTTPException(400, f"فایل «{upload.filename}» یک PDF معتبر نیست.") from exc
    if pages == 0:
        raise HTTPException(400, f"فایل «{upload.filename}» هیچ صفحه‌ای ندارد.")
    return data, pages


# ------------------------------------------------------------------------ meta


@app.get("/api/health")
def health():
    from .ocr.llm import engine_status

    engines = engine_status(settings)
    default = settings.default_ai_engine if engines.get(settings.default_ai_engine) else "offline"
    return {
        "ok": True,
        "engines": engines,
        "default_engine": default,
        "push_configured": bool(settings.dadrose_api_url and settings.dadrose_api_token),
    }


@app.get("/api/meta")
def meta():
    from .blueprints import SUBJECTS, blueprint_list

    return {
        "blueprints": blueprint_list(),
        "subjects": [{"key": s["key"], "name": s["name"]} for s in SUBJECTS],
    }


# -------------------------------------------------------------------- projects


@app.get("/api/projects", response_model=list[ProjectSummary])
def list_projects():
    return [_summary(p) for p in store.list()]


@app.post("/api/projects", response_model=Project)
async def create_project(
    booklet: Annotated[UploadFile, File()],
    explanations: Annotated[UploadFile | None, File()] = None,
    title: Annotated[str, Form()] = "",
    track: Annotated[Literal["bar", "center", "other"], Form()] = "other",
    year: Annotated[int | None, Form()] = None,
    blueprint: Annotated[str, Form()] = "auto",
    engine: Annotated[EngineName, Form()] = "auto",
):
    uploads: list[tuple[DocKind, UploadFile]] = [("booklet", booklet)]
    if explanations is not None and explanations.filename:
        uploads.append(("explanations", explanations))

    project = Project(
        id=uuid.uuid4().hex[:12],
        title=title.strip() or Path(booklet.filename or "دفترچه").stem,
        track=track,
        year=year,
        blueprint=blueprint or "auto",
        engine=engine,
        created_at=datetime.now(UTC),
    )
    contents = []
    for kind, upload in uploads:
        data, pages = await _read_pdf(upload)
        contents.append((kind, data))
        project.documents.append(
            DocInfo(kind=kind, filename=upload.filename or f"{kind}.pdf", page_count=pages)
        )
    project.progress.total = sum(d.page_count for d in project.documents)
    for kind, data in contents:
        store.save_upload(project.id, kind, data)
    store.save(project)
    jobs.submit(project.id)
    return project


@app.get("/api/projects/{project_id}", response_model=Project)
def get_project(project_id: str):
    return _load(project_id)


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str):
    with store.lock(project_id):
        store.delete(project_id)
    return {"ok": True}


@app.get("/api/projects/{project_id}/pages/{doc}/{page}.jpg")
def page_image(project_id: str, doc: DocKind, page: int, variant: str = ""):
    path = store.page_image(project_id, doc, page, orig=variant == "orig")
    if not path.is_file():
        raise HTTPException(404, "تصویر صفحه پیدا نشد.")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=3600"})


@app.get("/api/projects/{project_id}/pages/{doc}/{page}", response_model=PageResult)
def page_result(project_id: str, doc: DocKind, page: int):
    result = store.load_document(project_id, doc)
    if result is None or not 0 <= page < len(result.pages):
        raise HTTPException(404, "صفحه پیدا نشد.")
    return result.pages[page]


# ------------------------------------------------------------------- questions


@app.put("/api/projects/{project_id}/questions/{number}", response_model=Question)
def update_question(project_id: str, number: int, update: QuestionUpdate):
    with store.lock(project_id):
        project = _load(project_id)
        question = _find(project, number)
        content_fields = {"subject_key", "stem", "options", "correct_key", "explanation"}
        changed = {
            key
            for key in update.model_dump(exclude_unset=True)
            if getattr(question, key) != getattr(update, key)
        }
        for key in changed:
            setattr(question, key, getattr(update, key))
        if "correct_key" in changed:
            question.key_source = "manual"
        if content_fields & changed:
            question.edited = True
        _revalidate(project)
        store.save(project)
        return question


class NewQuestion(BaseModel):
    number: int


@app.post("/api/projects/{project_id}/questions", response_model=Question)
def add_question(project_id: str, body: NewQuestion):
    from .blueprints import subject_for
    from .models import Option

    with store.lock(project_id):
        project = _load(project_id)
        if any(q.number == body.number for q in project.questions):
            raise HTTPException(409, "سؤالی با این شماره وجود دارد.")
        question = Question(
            number=body.number,
            subject_key=subject_for(project.blueprint, body.number),
            options=[Option(key=str(k)) for k in range(1, 5)],
            edited=True,
        )
        project.questions.append(question)
        project.questions.sort(key=lambda q: q.number)
        _revalidate(project)
        store.save(project)
        return question


@app.delete("/api/projects/{project_id}/questions/{number}")
def delete_question(project_id: str, number: int):
    with store.lock(project_id):
        project = _load(project_id)
        question = _find(project, number)
        project.questions.remove(question)
        _revalidate(project)
        store.save(project)
    return {"ok": True}


class ReocrBody(BaseModel):
    engine: EngineName = "auto"


@app.post("/api/projects/{project_id}/questions/{number}/reocr", response_model=Question)
def reocr_question(project_id: str, number: int, body: ReocrBody = Body(default_factory=ReocrBody)):
    from .parser import parse_single_question
    from .pipeline import reocr_region

    project = _load(project_id)
    question = _find(project, number)
    regions = [r for r in question.regions if r.doc == "booklet"]
    if not regions:
        raise HTTPException(400, "محدوده‌ی این سؤال روی صفحه مشخص نیست.")
    lines = []
    try:
        for region in regions:
            image = store.page_image(project_id, "booklet", region.page)
            for line in reocr_region(image, region.bbox, body.engine, settings):
                line.page = region.page
                lines.append(line)
    except Exception as exc:
        raise HTTPException(502, f"بازخوانی ناموفق بود: {exc}") from exc
    parsed = parse_single_question(lines, "booklet")
    if parsed is None:
        raise HTTPException(422, "در محدوده‌ی بازخوانی‌شده سؤالی تشخیص داده نشد.")

    with store.lock(project_id):
        project = _load(project_id)
        question = _find(project, number)
        question.stem = parsed.stem
        if parsed.options:
            question.options = parsed.options
        question.flags = [f for f in question.flags if f.doc != "booklet"] + parsed.flags
        question.status = "pending"
        question.edited = False
        _revalidate(project)
        store.save(project)
        return question


class ReparseBody(BaseModel):
    blueprint: str | None = None


@app.post("/api/projects/{project_id}/reparse", response_model=Project)
def reparse(project_id: str, body: ReparseBody = Body(default_factory=ReparseBody)):
    project = _load(project_id)
    if project.status in ("queued", "processing"):
        raise HTTPException(409, "پروژه هنوز در حال پردازش است.")
    try:
        return jobs.parse(project_id, body.blueprint)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


# ---------------------------------------------------------------------- export


@app.get("/api/projects/{project_id}/export.json")
def export_json(project_id: str, only_approved: bool = False):
    from .export import to_dadrose_payload

    project = _load(project_id)
    payload = to_dadrose_payload(project, only_approved)
    return JSONResponse(
        payload,
        headers={"Content-Disposition": f'attachment; filename="dadrose-{project.id}.json"'},
    )


@app.get("/api/projects/{project_id}/export.docx")
def export_docx(project_id: str, only_approved: bool = False, exam_header: bool = True):
    from .export_docx import to_docx

    project = _load(project_id)
    return Response(
        to_docx(project, only_approved, exam_header),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="dadrose-{project.id}.docx"'},
    )


class PushBody(BaseModel):
    only_approved: bool = True


@app.post("/api/projects/{project_id}/push")
def push(project_id: str, body: PushBody = Body(default_factory=PushBody)):
    from .export import push_to_dadrose, to_dadrose_payload

    project = _load(project_id)
    payload = to_dadrose_payload(project, body.only_approved)
    if not payload["questions"]:
        raise HTTPException(400, "سؤالی برای ارسال وجود ندارد.")
    try:
        response = push_to_dadrose(payload, settings)
    except Exception as exc:
        raise HTTPException(502, str(exc)) from exc
    return {"ok": True, "response": response}


# ------------------------------------------------------------------ static UI

if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="ui")
