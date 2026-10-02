# معماری — DADROSE PDF → Text

سرویس مستقل برای تبدیل دفترچه‌های آزمون (PDF تایپی یا اسکن موبایل) به سؤال‌های
ساختاریافته‌ی سایت `dadrose-quiz`، با محیط بازبینی کنار‌هم.

```
backend/   FastAPI + OpenCV + PyMuPDF + Tesseract + Claude/Gemini   (Python 3.11, uv)
frontend/  Vite + React + TypeScript (built to frontend/dist, served by the backend at /)
```

## Pipeline

```
PDF ─► pdf_input.render_document ─► per page:
         ├─ text layer usable?  ─► words straight from PDF (source="text_layer")
         └─ else ─► preprocess (page detect + perspective, orientation, deskew,
                     shadow/illumination removal, contrast, upscale)
                  ─► ocr_tesseract  (words + boxes + confidence, always runs)
                  ─► AI engine (Claude/Gemini) transcription, if available
                  ─► consensus.merge (AI text aligned onto Tesseract boxes;
                     disagreements → flag="disagree", alt=Tesseract reading)
       ─► DocumentResult (lines of words, normalized bboxes)
       ─► parser.build_questions(booklet, explanations, blueprint)
            questions + options + key table + explanations + subjects
       ─► validate ─► Project (store/project.json) ─► review UI ─► export / push
```

## Module contract (backend/app)

All shapes are in `app/models.py`. BBoxes are normalized `[x0,y0,x1,y1]` on the
**processed** page image.

| Module | Public API | Owner |
|---|---|---|
| `config.py` | `Settings`, `get_settings()` | orchestrator |
| `models.py` | shared pydantic models | orchestrator |
| `normalize.py` | `normalize_text(s) -> str`, `to_ascii_digits(s) -> str`, `comparable(s) -> str` | parser agent |
| `pdf_input.py` | `render_document(pdf_bytes, dpi) -> Iterator[RenderedPage]`; `RenderedPage(index, image_bgr, text_words: list[Word] or None)` — `text_words` is None when the text layer is missing/garbled | OCR agent |
| `preprocess.py` | `preprocess(image_bgr) -> tuple[gray_ndarray, list[str]]` | OCR agent |
| `ocr/tesseract.py` | `ocr_tesseract(gray, page, settings) -> list[Line]` | OCR agent |
| `ocr/llm.py` | `get_ai_engine(name, settings) -> AiEngine or None`; `AiEngine.name`; `AiEngine.transcribe(jpeg: bytes, mode="page" or "region") -> str`; `engine_status(settings) -> dict` | OCR agent |
| `ocr/consensus.py` | `merge(ai_text, tess_lines, page) -> tuple[list[Line], list[str]]` | OCR agent |
| `pipeline.py` | `process_document(pdf_bytes, kind, filename, engine, settings, out_dir, on_progress) -> DocumentResult`; writes `out_dir/{kind}-{i}.jpg` (processed) and `{kind}-{i}-orig.jpg`; `reocr_region(image_path, bbox, engine, settings) -> list[Line]` | OCR agent |
| `blueprints.py` | `BLUEPRINTS`, `SUBJECTS`, `subject_for(blueprint, number) -> str or None` | parser agent |
| `parser.py` | `build_questions(booklet, explanations, blueprint) -> ParseResult`; `parse_single_question(lines, doc_kind) -> Question or None` | parser agent |
| `validate.py` | `validate_question(q, has_explanations) -> list[Issue]`; `validate_project(questions, has_explanations, expected_count) -> list[Issue]` | parser agent |
| `export.py` | `to_dadrose_payload(project, only_approved) -> dict`; `push_to_dadrose(payload, settings) -> dict` | parser agent |
| `store.py`, `jobs.py`, `main.py` | persistence, background jobs, HTTP API | orchestrator |

## HTTP API (consumed by the frontend)

All JSON. Errors: `{"detail": "<Persian message>"}`. Auth: HTTP Basic when `ADMIN_PASSWORD` is set.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ok, engines: {offline: bool, claude: bool, gemini: bool}, default_engine}` |
| GET | `/api/meta` | — | `{blueprints: [{code, title, track, year, question_count}], subjects: [{key, name}]}` |
| GET | `/api/projects` | — | `ProjectSummary[]` (newest first) |
| POST | `/api/projects` | multipart: `booklet` (file, required), `explanations` (file, optional), `title`, `track` (bar/center/other), `year`, `blueprint` (code or `auto`), `engine` (auto/offline/claude/gemini) | `Project` |
| GET | `/api/projects/{id}` | — | `Project` |
| DELETE | `/api/projects/{id}` | — | `{ok: true}` |
| GET | `/api/projects/{id}/pages/{doc}/{page}.jpg` | `?variant=orig` for the original render | image |
| GET | `/api/projects/{id}/pages/{doc}/{page}` | — | `PageResult` (lines + words + boxes, for hover/compare) |
| PUT | `/api/projects/{id}/questions/{number}` | `QuestionUpdate` | `Question` (re-validated) |
| POST | `/api/projects/{id}/questions` | `{number}` | `Question` (new empty question) |
| DELETE | `/api/projects/{id}/questions/{number}` | — | `{ok: true}` |
| POST | `/api/projects/{id}/questions/{number}/reocr` | `{engine}` | `Question` (re-read from its regions with the given engine; edits replaced) |
| POST | `/api/projects/{id}/reparse` | `{blueprint?}` | `Project` (re-run parser on stored OCR; keeps nothing manual) |
| GET | `/api/projects/{id}/export.json` | `?only_approved=1` | DADROSE payload (download) |
| POST | `/api/projects/{id}/push` | `{only_approved: bool}` | `{ok, response}` |

While `status` is `queued`/`processing` the frontend polls `GET /api/projects/{id}` every ~2 s.

## DADROSE payload

Shaped after `dadrose-quiz/backend/content/models.py` (`Question`, `Option`, `QuestionSource`):

```json
{
  "source": {"kind": "official", "track": "bar", "year": 1404, "title": "..."},
  "questions": [
    {"source_number": 1, "subject_key": "civil", "stem_html": "<p>…</p>",
     "options": [{"key": "1", "order": 1, "text_html": "…"}, …],
     "correct_key": "2", "explanation_html": "<p>…</p>"}
  ]
}
```

Pushed to `POST {DADROSE_API_URL}/api/v1/admin/questions/import` with
`Authorization: Bearer {DADROSE_API_TOKEN}` — endpoint to be added to `dadrose-quiz`.
