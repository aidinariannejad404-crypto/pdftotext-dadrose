# دادرز — تبدیل PDF و عکس به سؤال و متن

ابزار ادمین برای سایت آزمون **دادرز**: دفترچه‌ی آزمون، کتاب تست، بانک نکات یا هر سند
فارسی دیگری را (PDF تایپی، اسکن CamScanner / اسکنر آیفون، یا عکس موبایل) به متن دقیق
تبدیل می‌کند، سؤال‌ها را با گزینه‌ها، کلید و پاسخ تشریحی جدا می‌کند و در یک محیط
کنار‌هم (تصویر صفحه ↔ متن) برای بازبینی سریع نمایش می‌دهد. خروجی نهایی فایل Word در
**قالب رسمی «ورود هوشمند از ورد» سایت** است.

## امکانات

- **ورودی:** PDF (تایپی یا اسکن‌شده) و عکس (JPG، PNG، HEIC آیفون، TIFF)؛ چند فایل/عکس
  به ترتیب صفحه.
- **پیش‌پردازش اسکن موبایل:** برش و اصلاح پرسپکتیو، تشخیص چرخش، صاف کردن کجی، حذف سایه
  و نور ناهموار، بهبود کنتراست، بزرگ‌نمایی هوشمند.
- **موتور خواندن متن:** Tesseract با مدل `tessdata_best` فارسی (آفلاین، همیشه در دسترس)
  + به‌صورت اختیاری **Claude** یا **Gemini** برای بالاترین دقت؛ اختلاف دو موتور به‌عنوان
  «کلمه‌ی مشکوک» علامت می‌خورد.
- **انواع محتوا:**
  - دفترچه‌ی آزمون رسمی (کانون / مرکز) با جدول کلید آخر دفترچه و فایل پاسخ تشریحی جدا؛
    درس هر سؤال از الگوی آزمون.
  - کتاب تست: پاسخ «گزینه‌ی «د» درست است» زیر هر سؤال، منبع سؤال مثل «ارشد سراسری-۷۸»،
    گزینه‌های دوتایی در یک خط.
  - متن کامل (بانک نکات، جزوه، کتاب): ویرایش صفحه‌به‌صفحه.
- **بازبینی:** تصویر صفحه کنار متن، هایلایت محل سؤال و کلمه‌های مشکوک روی تصویر،
  حل کلمه‌ی مشکوک با یک کلیک، «خطای بعدی» (F8)، تأیید و بعدی (Ctrl+Enter)، ذخیره‌ی
  خودکار، بازخوانی یک سؤال با هوش مصنوعی، نسخه‌ی موبایل.
- **صرفه‌جویی در هوش مصنوعی (حالت «هوشمند»، پیش‌فرض):** همه‌چیز اول آفلاین خوانده می‌شود؛
  صفحه‌ی باکیفیت به هوش مصنوعی نمی‌رود، برای صفحه‌ی متوسط فقط خط‌های مشکوک برای «اصلاح»
  فرستاده می‌شود، فقط صفحه‌ی خیلی بد کامل بازنویسی می‌شود، و سؤالی که ساختارش خراب مانده
  فقط ناحیه‌ی خودش دوباره خوانده می‌شود. پاسخ‌ها کش می‌شوند، هر پروژه سقف مصرف دارد، مصرف و
  هزینه نمایش داده می‌شود و کلمه‌هایی که ادمین اصلاح می‌کند یاد گرفته می‌شوند.
- **خروجی:** Word در قالب رسمی سایت (بررسی‌شده با پارسر خود سایت)، JSON، TXT.

## روند کار ادمین

۱. فایل را بارگذاری و نوع محتوا را انتخاب کنید (یا «تشخیص خودکار»).
۲. سؤال‌ها/صفحه‌ها را با تصویر مقایسه، اصلاح و تأیید کنید.
۳. «دانلود فایل Word» ← در پنل سایت: «ورود هوشمند از ورد» ← بازبینی تکراری‌ها و ثبت.

## اجرا روی سیستم خودتان (برای تست)

**ویندوز:**

۱. این‌ها را نصب کنید (یک بار):
   - [Git](https://git-scm.com/download/win) و [Node.js LTS](https://nodejs.org)
   - uv: در PowerShell ‏`powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"`
   - Tesseract: نصب‌کننده‌ی [UB Mannheim](https://github.com/UB-Mannheim/tesseract/wiki)؛ هنگام نصب
     در «Additional language data» گزینه‌ی **Persian** را تیک بزنید.
۲. یک ترمینال PowerShell جدید باز کنید:

```powershell
git clone https://github.com/aidinariannejad404-crypto/pdftotext-dadrose.git
cd pdftotext-dadrose
powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1
```

مرورگر خودکار روی `http://127.0.0.1:8000` باز می‌شود. بعد از دریافت کد جدید (`git pull`) با
`-Rebuild` اجرا کنید. برای فعال کردن Claude، کلید را در `backend\.env` بگذارید
(`ANTHROPIC_API_KEY=...`) و دوباره اجرا کنید.

**مک / لینوکس:** `brew install uv node tesseract tesseract-lang` (یا معادل apt) و سپس
`./scripts/start.sh`.

## نصب روی سرور (Docker)

```bash
git clone <repo> && cd pdftotext-dadrose
cp backend/.env.example backend/.env    # رمز ادمین و (اختیاری) کلید هوش مصنوعی را پر کنید
docker compose up -d --build            # http://SERVER:8000
```

- حداقل منابع: ۲ هسته CPU، ۴ گیگ رم. داده‌ها در volume `ocr-data` می‌مانند.
- **حتماً `ADMIN_PASSWORD` را تنظیم کنید** و سرویس را پشت HTTPS (مثلاً Nginx) قرار دهید.
- سرور ایران و هوش مصنوعی: با `HTTPS_PROXY` یا یک رله در سرور خارج
  (`ANTHROPIC_BASE_URL` / `GEMINI_BASE_URL`) تماس‌ها را عبور دهید. بدون کلید، همه‌چیز
  آفلاین با Tesseract کار می‌کند.

### تنظیمات مهم (`backend/.env`)

| متغیر | توضیح |
|---|---|
| `ADMIN_PASSWORD` | رمز ورود (HTTP Basic) |
| `ANTHROPIC_API_KEY` / `CLAUDE_MODEL` / `CLAUDE_EFFORT` | موتور Claude (پیش‌فرض `claude-opus-5-5`) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | موتور Gemini |
| `DEFAULT_AI_ENGINE` | موتور حالت «خودکار»: `claude` یا `gemini` |
| `HTTPS_PROXY`, `ANTHROPIC_BASE_URL`, `GEMINI_BASE_URL` | عبور از پراکسی/رله |
| `TESSDATA_DIR`, `TESSERACT_LANG` | مدل‌های Tesseract (در Docker تنظیم شده) |
| `WORKERS`, `RENDER_DPI` | موازی‌سازی و وضوح رندر |
| `DADROSE_API_URL`, `DADROSE_API_TOKEN` | ارسال مستقیم به سایت (پس از ساخت endpoint در سایت) |

## توسعه

```bash
# backend (Python 3.11, uv) — نیازمند tesseract-ocr و tesseract-ocr-fas
cd backend && uv sync && uv run uvicorn app.main:app --reload
uv run pytest && uv run ruff check . && uv run ruff format --check .

# frontend (Node 22)
cd frontend && npm install
npm run dev        # پروکسی /api به :8000
npm run dev:mock   # بدون بک‌اند، با داده‌ی نمونه
npm run build      # خروجی در frontend/dist که بک‌اند در / سرو می‌کند
npm test           # Playwright روی mock
npm run test:real  # Playwright روی بک‌اند واقعی (ابتدا build و اجرای بک‌اند)
```

معماری و قرارداد API: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — گزارش سرعت و
بهره‌وری: `docs/RESEARCH-performance.md`.

## نکته‌ی امنیتی

این مخزن عمومی است: هیچ فایل آزمون/کتاب واقعی، کلید API یا فایل `.env` را commit نکنید.
