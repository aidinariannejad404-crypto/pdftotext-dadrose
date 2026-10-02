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

## Mock (`mock/`)

`vite --mode mock` registers `mock/plugin.ts` as dev-server middleware implementing every endpoint in `docs/ARCHITECTURE.md` with in-memory state: one ready project (`demo`, 10 Persian questions, Q8 missing, flags/issues/explanations), one stuck in OCR, one failed. Uploads finish "processing" in ~9 s. Page images are SVGs generated from the same layout as the OCR word boxes, so overlays line up. `POST /api/__mock/reset` restores the seed.

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
