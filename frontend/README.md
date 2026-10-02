# DADROSE PDF → Text — frontend

رابط کاربری مدیریت (فارسی، راست‌به‌چپ) برای بارگذاری دفترچه‌ی آزمون، بازبینی کنارِهم «تصویر صفحه / متن استخراج‌شده»، تأیید سؤال‌ها و ارسال به سایت دادرس.

Vite + React 19 + TypeScript (strict), plain CSS (tokens in `src/styles.css`, dark mode via `prefers-color-scheme`). No router/UI kit: hash routes `#/` (projects) and `#/p/:id[?q=N]` (review).

## Commands

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api → http://127.0.0.1:8000 (FastAPI)
npm run dev:mock   # same UI with an in-process fake API (no backend needed)
npm run build      # tsc --noEmit + vite build → dist/ (served by the backend at /)
npm run typecheck
npm test           # Playwright smoke tests against the mock (starts dev:mock on :5174)
npm run screenshots  # writes screenshots/*.png (desktop 1440 / mobile 390, dark)
```

Playwright uses the pre-installed Chromium (`PLAYWRIGHT_BROWSERS_PATH`); `@playwright/test` is pinned to 1.56.1 to match it. Set `PW_CHROMIUM=/path/to/chrome` to use another binary.

## UX flow (for non-technical admins)

1. Projects page: dismissible 3-step guide (remembered in localStorage), simplified upload — booklet file(s) + آزمون + سال are required; PDFs and/or page photos (JPG/PNG/HEIC…, several files, reorderable = page order); title and blueprint are auto-filled (blueprint/engine live under «تنظیمات پیشرفته»). The submit button explains what is missing.
2. Review: actionable issue sentences (click → focuses the field), suspicious-word cards («X یا Y؟» → keep / use alternative, persisted via `PUT … {flags}`), «خطای بعدی» (F8 / Alt+N), help dialog (`?`), completion card with the Word download + import steps.
3. Export: «دانلود فایل Word» (`/export.docx`, the site's «ورود هوشمند از ورد» template) is the primary action; JSON and direct push live in «بیشتر» (push disabled unless `health.push_configured`).

## Two review modes

`Project.mode` decides the review screen at `#/p/:id`:

- **questions** (`ReviewPage` + `Editor`): exam booklets / test books — questions, options, key, explanation, «منبع سؤال» (`source_ref`).
- **text** (`TextReview`): notes banks, lecture notes, books — page-by-page full-text editor (`GET/PUT /pages/{doc}/{page}/text`, autosave, «بازگردانی متن اصلی» = `text: null`), page thumbnails, «تأیید و صفحه‌ی بعد», «صفحه‌ی مشکوک بعدی», Word/TXT export (`export-text.docx`, `export.txt`). Suspicious words come from the page's OCR `Word.flag/alt` and are highlighted in the editor and on the image.
- Switch with «بیشتر» → «نمایش به‌صورت متن کامل» / «تبدیل به حالت سؤال» (`POST /mode`). Upload sends `doc_type` (auto / questions / text).

## Mock (`mock/`)

`vite --mode mock` registers `mock/plugin.ts` as dev-server middleware implementing every endpoint in `docs/ARCHITECTURE.md` with in-memory state: one ready project (`demo`, 10 Persian questions, Q8 missing, flags/issues/explanations), one stuck in OCR, one failed, and a text-mode project `notes` («بانک نکات حقوق مدنی», 3 pages). Uploads (multiple files per field) finish "processing" in ~9 s; `export.docx` returns dummy bytes; `push_configured` is false. Page images are SVGs generated from the same layout as the OCR word boxes, so overlays line up. `POST /api/__mock/reset` restores the seed.

## Structure

```
src/api.ts            typed client (errors → ApiError with the API's Persian `detail`)
src/types.ts          mirrors backend/app/models.py
src/useDraft.ts       per-question draft + 800 ms debounced autosave (PUT)
src/pageCache.ts      lazy cached GET /pages/{doc}/{page} (OCR words for hover/compare)
src/components/
  ProjectsPage.tsx    upload card + project list (polls every 2 s while processing)
  ReviewPage.tsx      processing view, 3-pane review, header actions, dialogs, shortcuts
  Navigator.tsx       progress, filters, question chips grouped by subject
  Editor.tsx          question fields, key radios, issues, suspicious-word chips
  HighlightField.tsx  auto-growing textarea with inline <mark> highlights (mirror technique)
  PageViewer.tsx      page image, zoom, regions/flag/word overlays, OCR tooltip & text panel
```

## Shortcuts

Ctrl+Enter تأیید و بعدی · Alt+↑/↓ یا PageUp/PageDown سؤال قبلی/بعدی · Ctrl+S ذخیره · Ctrl+چرخ ماوس روی تصویر: بزرگ‌نمایی
