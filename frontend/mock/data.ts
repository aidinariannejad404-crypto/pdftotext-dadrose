// Fake data for `npm run dev:mock`: a booklet with ~10 Persian questions whose
// page images (SVG) and OCR word boxes are generated from the same layout, so
// overlays line up exactly with the rendered text.
import type {
  BBox, DocKind, Flag, Issue, Line, Meta, PageResult, Project, Question, Word, WordFlag,
} from '../src/types';

export const PAGE_W = 1240;
export const PAGE_H = 1754;
const FONT = 25;
const LINE_H = 46;
const MARGIN_X = 96;
const CHAR_W = 13.6;
const SPACE_W = 11;

export const META: Meta = {
  blueprints: [
    { code: 'BAR-1405', title: 'آزمون ورودی کارآموزی کانون وکلا ۱۴۰۵', track: 'bar', year: 1405, question_count: 140 },
    { code: 'CENTER-1404', title: 'آزمون وکالت مرکز وکلا ۱۴۰۴', track: 'center', year: 1404, question_count: 135 },
    { code: 'CENTER-1405', title: 'آزمون وکالت مرکز وکلا ۱۴۰۵', track: 'center', year: 1405, question_count: 135 },
    { code: 'CENTER-1402', title: 'آزمون وکالت مرکز وکلا ۱۴۰۲ (بازسازی)', track: 'center', year: 1402, question_count: 130 },
  ],
  subjects: [
    { key: 'civil', name: 'حقوق مدنی' },
    { key: 'civil_procedure', name: 'آیین دادرسی مدنی' },
    { key: 'criminal', name: 'حقوق جزا' },
    { key: 'criminal_procedure', name: 'آیین دادرسی کیفری' },
    { key: 'commercial', name: 'حقوق تجارت' },
    { key: 'usul_fiqh', name: 'اصول فقه' },
    { key: 'fiqh_bar', name: 'متون فقه کانون وکلا' },
    { key: 'constitutional', name: 'حقوق اساسی' },
    { key: 'fiqh_center', name: 'متون فقه مرکز وکلا' },
    { key: 'registration_law', name: 'حقوق ثبت مرکز وکلا' },
  ],
  topics: {
    civil: ['اموال و مالکیت', 'شرایط اساسی صحت معامله', 'خیارات', 'عقد بیع', 'عقد اجاره'],
    civil_procedure: ['صلاحیت دادگاه‌ها', 'تجدیدنظر', 'دادرسی فوری'],
    commercial: ['تاجر و اعمال تجارتی', 'اسناد تجاری', 'شرکت‌های تجاری'],
    criminal: ['شروع به جرم', 'علل موجهه‌ی جرم', 'مجازات‌ها'],
    criminal_procedure: ['قرارهای تأمین', 'تحقیقات مقدماتی'],
    constitutional: ['حقوق ملت', 'قوه‌ی قضاییه'],
  },
  laws: [
    { key: 'civil_code', name: 'قانون مدنی', subject_key: 'civil' },
    { key: 'civil_procedure_code', name: 'قانون آیین دادرسی مدنی', subject_key: 'civil_procedure' },
    { key: 'commercial_code', name: 'قانون تجارت', subject_key: 'commercial' },
    { key: 'penal_code', name: 'قانون مجازات اسلامی', subject_key: 'criminal' },
    { key: 'criminal_procedure_code', name: 'قانون آیین دادرسی کیفری', subject_key: 'criminal_procedure' },
    { key: 'constitution', name: 'قانون اساسی', subject_key: 'constitutional' },
  ],
};

interface SeedFlag {
  field: string;
  word: string;
  reason: WordFlag;
  alt?: string;
}

interface SeedQuestion {
  number: number;
  subject: string | null;
  stem: string;
  options: [string, string, string, string];
  key: string | null;
  keySource: Question['key_source'];
  explanation: string;
  flags?: SeedFlag[];
}

const SEED: SeedQuestion[] = [
  {
    number: 1, subject: 'civil',
    stem: 'در کدام مورد عقد بیع باطل است؟',
    options: ['فروش مال غیر بدون اجازه‌ی مالک', 'فروش مال مرهونه بدون اذن مرتهن', 'فروش عین مستأجره', 'فروش مالی که وجود آن معلوم نیست'],
    key: '4', keySource: 'table',
    explanation: 'طبق ماده‌ی ۳۶۱ قانون مدنی اگر در بیع عین معین معلوم شود که مبیع وجود نداشته، بیع باطل است.',
  },
  {
    number: 2, subject: 'civil',
    stem: 'مستاجر بدون اذن موجر عین مستأجره را به دیگری اجاره داده است. حکم قضیه چیست؟',
    options: ['اجاره‌ی دوم صحیح است مگر آنکه در عقد شرط خلاف شده باشد', 'اجاره‌ی دوم باطل است', 'اجاره‌ی دوم غیرنافذ است', 'موجر حق فسخ اجاره‌ی اول را دارد'],
    key: '1', keySource: 'table',
    explanation: 'به موجب ماده‌ی ۴۷۴ قانون مدنی مستأجر می‌تواند عین مستأجره را به دیگری اجاره دهد مگر اینکه در عقد خلاف آن شرط شده باشد.',
    flags: [
      { field: 'stem', word: 'مستاجر', reason: 'disagree', alt: 'مستأجر' },
      { field: 'option:1', word: 'خلاف', reason: 'low_conf' },
    ],
  },
  {
    number: 3, subject: 'civil',
    stem: 'مهلت اعمال خیار تأخیر ثمن در بیع چند روز است؟',
    options: ['یک روز', 'سه روز', 'هفت روز', 'ده روز'],
    key: '2', keySource: 'explanation',
    explanation: 'مطابق ماده‌ی ۴۰۲ قانون مدنی هرگاه مبیع تسلیم نشده و ثمن تأدیه نشود بایع پس از سه روز اختیار فسخ دارد.',
    flags: [{ field: 'option:2', word: 'سه', reason: 'disagree', alt: 'سر' }],
  },
  {
    number: 4, subject: 'civil_procedure',
    stem: 'دادگاه صالح برای رسیدگی به دعوای مربوط به اموال غیرمنقول کدام است؟',
    options: ['دادگاه محل اقامت خوانده', 'دادگاه محل وقوع مال', 'دادگاه محل اقامت خواهان', 'دادگاه محل انعقاد قرارداد'],
    key: null, keySource: null,
    explanation: 'ماده‌ی ۱۲ قانون آیین دادرسی مدنی دعاوی راجع به اموال غیرمنقول را در صلاحیت دادگاه محل وقوع مال می‌داند.',
  },
  {
    number: 5, subject: 'civil_procedure',
    stem: 'مهلت تجدیدنظرخواهی برای اشخاص مقیم ایران از تاریخ ابلاغ رأی چقدر است؟',
    options: ['ده روز', 'بیست روز', 'یک ماه', 'دو ماه'],
    key: '2', keySource: 'table',
    explanation: 'طبق ماده‌ی ۳۳۶ مهلت درخواست تجدیدنظر برای اصحاب دعوا مقیم ایران بیست روز و برای مقیمین خارج دو ماه است.',
    flags: [{ field: 'explanation', word: 'اصحاب', reason: 'low_conf' }],
  },
  {
    number: 6, subject: 'criminal',
    stem: 'شروع به جرم در کدام یک از جرائم زیر قابل مجازات است؟',
    options: ['جرائم تعزیری درجه‌ی هشت', 'جرائمی که مجازات قانونی آن سلب حیات است', '', 'کلیه‌ی جرائم عمدی'],
    key: '2', keySource: 'table',
    explanation: 'ماده‌ی ۱۲۲ قانون مجازات اسلامی شروع به جرائمی که مجازات قانونی آن‌ها سلب حیات یا حبس دائم است را قابل مجازات دانسته است.',
  },
  {
    number: 7, subject: 'criminal',
    stem: 'کدام یک از موارد زیر از علل موجهه‌ی جرم محسوب می‌شود؟',
    options: ['اکراه', 'دفاع مشروع', 'جنون', 'صغر'],
    key: '2', keySource: 'table',
    explanation: '',
    flags: [{ field: 'stem', word: 'موجهه‌ی', reason: 'disagree', alt: 'موجبه‌ی' }],
  },
  {
    number: 9, subject: 'criminal_procedure',
    stem: 'قرار بازداشت موقت صادره از سوی بازپرس پس از موافقت دادستان در چه مهلتی قابل اعتراض است؟',
    options: ['پنج روز', 'ده روز', 'پانزده روز', 'بیست روز'],
    key: '2', keySource: 'explanation',
    explanation: 'به موجب ماده‌ی ۲۴۰ قانون آیین دادرسی کیفری مهلت اعتراض به قرار بازداشت موقت ده روز از تاریخ ابلاغ است.',
    flags: [
      { field: 'stem', word: 'بازپرس', reason: 'low_conf' },
      { field: 'option:3', word: 'پانزده', reason: 'disagree', alt: 'یانزده' },
    ],
  },
  {
    number: 10, subject: 'commercial',
    stem: 'کدام یک از اسناد زیر سند تجاری محسوب نمی‌شود؟',
    options: ['برات', 'سفته', 'چک', 'قولنامه'],
    key: '4', keySource: 'table',
    explanation: 'اسناد تجاری در قانون تجارت شامل برات، سفته و چک است و قولنامه سند تجاری نیست.',
  },
  {
    number: 11, subject: 'commercial',
    stem: 'حداقل تعداد سهامداران شرکت سهامی خاص چند نفر است؟',
    options: ['دو نفر', 'سه نفر', 'پنج نفر', 'هفت نفر'],
    key: '2', keySource: 'manual',
    explanation: 'طبق لایحه‌ی اصلاحی قانون تجارت تعداد سهامداران شرکت سهامی خاص نباید کمتر از سه نفر باشد.',
    flags: [{ field: 'stem', word: 'سهامداران', reason: 'disagree', alt: 'سهام‌داران' }],
  },
];

const FA = '۰۱۲۳۴۵۶۷۸۹';
const fa = (n: number | string) => String(n).replace(/[0-9]/g, (d) => FA[Number(d)]);
const round = (v: number) => Math.round(v * 10000) / 10000;

// ------------------------------------------------------------------ layout

interface PlacedWord extends Word {
  px: [number, number, number, number]; // pixel box
  field?: string;
  qn?: number;
}
interface PlacedLine {
  words: PlacedWord[];
  y: number;
  bold?: boolean;
}
interface PageLayout {
  doc: DocKind;
  index: number;
  lines: PlacedLine[];
  heading: string;
}

function wordWidth(w: string): number {
  return Math.max(14, w.replace(/[‌ً-ٟ]/g, '').length * CHAR_W);
}

/** Lay out text right-to-left, wrapping at the page width; returns lines of words. */
function layoutText(text: string, y0: number, indent: number, field: string | undefined, qn: number | undefined): PlacedLine[] {
  const maxRight = PAGE_W - MARGIN_X - indent;
  const minLeft = MARGIN_X;
  const lines: PlacedLine[] = [];
  let y = y0;
  let x = maxRight;
  let cur: PlacedWord[] = [];
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    const w = wordWidth(tok);
    if (x - w < minLeft && cur.length) {
      lines.push({ words: cur, y });
      cur = [];
      y += LINE_H;
      x = maxRight - 24; // hanging indent for continuation lines
    }
    const px: [number, number, number, number] = [x - w, y - FONT + 2, x, y + 9];
    cur.push({ text: tok, bbox: null, conf: 88 + ((tok.length * 7) % 11), flag: null, alt: null, px, field, qn });
    x -= w + SPACE_W;
  }
  if (cur.length) lines.push({ words: cur, y });
  return lines;
}

function norm(px: [number, number, number, number]): BBox {
  return [round(px[0] / PAGE_W), round(px[1] / PAGE_H), round(px[2] / PAGE_W), round(px[3] / PAGE_H)];
}

function unionPx(words: PlacedWord[]): [number, number, number, number] {
  return [
    Math.min(...words.map((w) => w.px[0])), Math.min(...words.map((w) => w.px[1])),
    Math.max(...words.map((w) => w.px[2])), Math.max(...words.map((w) => w.px[3])),
  ];
}

const pages: PageLayout[] = [];
const regionsByQ = new Map<number, { doc: DocKind; page: number; px: [number, number, number, number] }[]>();

function addRegion(qn: number, doc: DocKind, page: number, lines: PlacedLine[]) {
  const u = unionPx(lines.flatMap((l) => l.words));
  const pad = 10;
  const list = regionsByQ.get(qn) ?? [];
  list.push({ doc, page, px: [MARGIN_X - pad, u[1] - pad, PAGE_W - MARGIN_X + pad, u[3] + pad] });
  regionsByQ.set(qn, list);
}

(function buildLayout() {
  // Booklet: 5 questions per page.
  const perPage = 5;
  for (let p = 0; p * perPage < SEED.length; p++) {
    const page: PageLayout = { doc: 'booklet', index: p, lines: [], heading: 'آزمون ورودی کارآموزی وکالت کانون وکلای دادگستری — ۱۴۰۳' };
    let y = 230;
    for (const q of SEED.slice(p * perPage, (p + 1) * perPage)) {
      const qLines: PlacedLine[] = [];
      const stem = layoutText(`${fa(q.number)}- ${q.stem}`, y, 0, 'stem', q.number);
      stem.forEach((l) => (l.bold = true));
      qLines.push(...stem);
      y += stem.length * LINE_H + 6;
      q.options.forEach((opt, i) => {
        const ol = layoutText(`${fa(i + 1)}) ${opt || '…'}`, y, 30, `option:${i + 1}`, q.number);
        qLines.push(...ol);
        y += ol.length * LINE_H;
      });
      addRegion(q.number, 'booklet', p, qLines);
      page.lines.push(...qLines);
      y += 34;
    }
    pages.push(page);
  }
  // Explanations: one page.
  const ex: PageLayout = { doc: 'explanations', index: 0, lines: [], heading: 'پاسخ تشریحی — آزمون کانون وکلا ۱۴۰۳' };
  let y = 230;
  for (const q of SEED) {
    if (!q.explanation) continue;
    const key = q.key ? ` گزینه‌ی ${fa(q.key)} صحیح است.` : '';
    const l = layoutText(`${fa(q.number)}-${key} ${q.explanation}`, y, 0, 'explanation', q.number);
    addRegion(q.number, 'explanations', 0, l);
    ex.lines.push(...l);
    y += l.length * LINE_H + 22;
  }
  pages.push(ex);
})();

// Attach flags to the matching placed words.
const flagsByQ = new Map<number, Flag[]>();
for (const q of SEED) {
  const flags: Flag[] = [];
  for (const f of q.flags ?? []) {
    const doc: DocKind = f.field === 'explanation' ? 'explanations' : 'booklet';
    let found: { page: PageLayout; w: PlacedWord } | null = null;
    for (const page of pages.filter((pg) => pg.doc === doc)) {
      for (const line of page.lines) {
        for (const w of line.words) {
          if (!found && w.qn === q.number && w.field === f.field && w.text.replace(/[.،؟:]$/, '') === f.word) found = { page, w };
        }
      }
    }
    if (found) {
      found.w.flag = f.reason;
      found.w.alt = f.alt ?? null;
      found.w.conf = f.reason === 'low_conf' ? 41 : 72;
    }
    flags.push({
      field: f.field, word: f.word, doc, page: found?.page.index ?? 0,
      bbox: found ? norm(found.w.px) : null, reason: f.reason, alt: f.alt ?? null,
    });
  }
  flagsByQ.set(q.number, flags);
}

export type PageSet = 'exam' | 'notes';
const AI_FIXED: Record<string, string> = { مرهونه: 'مرهوبه', مالک: 'مانک' };
const setPages = (set: PageSet) => (set === 'notes' ? notesPages : pages);

export function pageResult(doc: DocKind, index: number, set: PageSet = 'exam'): PageResult | null {
  const page = setPages(set).find((p) => p.doc === doc && p.index === index);
  if (!page) return null;
  const lines: Line[] = page.lines.map((l) => ({
    page: index,
    bbox: norm(unionPx(l.words)),
    words: l.words.map((w) => ({
      text: w.text, bbox: norm(w.px), conf: w.conf, flag: w.flag,
      // alt without flag = the AI corrected this word (Tesseract read the alt)
      alt: w.alt ?? (set === 'exam' && !w.flag ? AI_FIXED[w.text] ?? null : null),
    })),
  }));
  const mode = set === 'notes' ? 'none' : doc === 'explanations' ? 'transcribe' : index === 0 ? 'correct' : 'none';
  const quality = set === 'notes' ? 0.95 : doc === 'explanations' ? 0.38 : index === 0 ? 0.71 : 0.93;
  return {
    index, width: PAGE_W, height: PAGE_H, source: 'ocr', engine: 'claude+tesseract',
    preprocess: ['page_detect', 'perspective', 'deskew', 'shadow_removal', 'contrast'],
    lines,
    edited_text: null,
    approved: false,
    ai_mode: mode,
    quality,
    ai_usage: mode === 'none' ? { calls: 0, cached: 0, input_tokens: 0, output_tokens: 0 } : { calls: 2, cached: 1, input_tokens: 4900, output_tokens: 1300 },
    warnings: set === 'exam' && doc === 'booklet' && index === 1 ? ['کیفیت اسکن پایین است؛ برخی کلمات با اطمینان کم خوانده شدند.'] : [],
  };
}

export function pageCount(doc: DocKind, set: PageSet = 'exam'): number {
  return setPages(set).filter((p) => p.doc === doc).length;
}

let fontDataUri: string | null = null;
export function setFontData(b64: string) {
  fontDataUri = `data:font/woff2;base64,${b64}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** SVG standing in for the page JPEG. `orig` simulates the raw phone scan. */
export function pageSvg(doc: DocKind, index: number, orig: boolean, set: PageSet = 'exam'): string | null {
  const page = setPages(set).find((p) => p.doc === doc && p.index === index);
  if (!page) return null;
  const font = fontDataUri ? `@font-face{font-family:Vz;src:url(${fontDataUri}) format('woff2');}` : '';
  const words = page.lines
    .flatMap((l) =>
      l.words.map((w) => {
        const cxp = (w.px[0] + w.px[2]) / 2;
        return `<text x="${cxp.toFixed(1)}" y="${l.y}" ${l.bold ? 'font-weight="600"' : ''}>${esc(w.text)}</text>`;
      }),
    )
    .join('');
  const body = `
    <rect x="0" y="0" width="${PAGE_W}" height="${PAGE_H}" fill="${orig ? '#f2efe6' : '#ffffff'}"/>
    <text x="${PAGE_W / 2}" y="120" font-size="30" font-weight="700">${esc(page.heading)}</text>
    <line x1="${MARGIN_X}" y1="160" x2="${PAGE_W - MARGIN_X}" y2="160" stroke="#222" stroke-width="2"/>
    <g font-size="${FONT}">${words}</g>
    <text x="${PAGE_W / 2}" y="${PAGE_H - 60}" font-size="22" fill="#555">صفحه‌ی ${fa(index + 1)}</text>`;
  const content = orig
    ? `<rect width="100%" height="100%" fill="#6b6b6b"/>
       <g transform="translate(40 30) rotate(1.4 ${PAGE_W / 2} ${PAGE_H / 2}) scale(0.94)" filter="url(#sh)">${body}</g>
       <rect width="100%" height="100%" fill="url(#shade)"/>`
    : body;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}">
<defs><style>${font} text{font-family:Vz,'Vazirmatn','DejaVu Sans',Tahoma,sans-serif;fill:#111;text-anchor:middle;direction:rtl;}</style>
<filter id="sh"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-opacity="0.4"/></filter>
<linearGradient id="shade" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.28"/></linearGradient></defs>
${content}
</svg>`;
}

// -------------------------------------------------------------- notes (text mode)

interface NotesPage {
  heading: string;
  blocks: { text: string; bold?: boolean }[];
  flags: { word: string; reason: WordFlag; alt?: string }[];
}

const NOTES: NotesPage[] = [
  {
    heading: 'بانک نکات حقوق مدنی — فصل اول: اموال و مالکیت',
    blocks: [
      { text: 'نکته ۱: مال غیرمنقول', bold: true },
      { text: 'مال غیرمنقول آن است که از محلی به محل دیگر نتوان نقل نمود اعم از اینکه استقرار آن ذاتی باشد یا به واسطه‌ی عمل انسان؛ به نحوی که نقل آن مستلزم خرابی یا نقص خود مال یا محل آن شود.' },
      { text: 'نکته ۲: حق انتفاع', bold: true },
      { text: 'انتفاع عبارت از حقی است که به موجب آن شخص می‌تواند از مالی که عین آن ملک دیگری است یا مالک خاصی ندارد استفاده کند. عمری، رقبی و سکنی از اقسام حق انتفاع هستند.' },
      { text: 'نکته ۳: ارتفاق', bold: true },
      { text: 'ارتفاق حقی است برای شخص در ملک دیگری؛ مانند حق عبور و حق مجرا. صاحب ملک نمی‌تواند مانع استفاده‌ی صاحب حق شود.' },
    ],
    flags: [
      { word: 'مستلزم', reason: 'disagree', alt: 'مستلرم' },
      { word: 'رقبی', reason: 'low_conf' },
    ],
  },
  {
    heading: 'فصل دوم: قراردادها',
    blocks: [
      { text: 'نکته ۴: شرایط اساسی صحت معامله', bold: true },
      { text: 'برای صحت هر معامله شرایط ذیل اساسی است: قصد طرفین و رضای آن‌ها، اهلیت طرفین، معین بودن موضوع معامله و مشروعیت جهت معامله.' },
      { text: 'نکته ۵: معامله‌ی فضولی', bold: true },
      { text: 'معامله به مال غیر جز به عنوان ولایت یا وصایت یا وکالت نافذ نیست، ولو اینکه صاحب مال باطناً راضی باشد؛ ولی اگر مالک بعد از وقوع معامله آن را اجازه نمود در این صورت معامله صحیح و نافذ می‌شود.' },
    ],
    flags: [
      { word: 'اهلیت', reason: 'disagree', alt: 'اهليت' },
      { word: 'باطناً', reason: 'low_conf' },
      { word: 'وصایت', reason: 'disagree', alt: 'وصاپت' },
    ],
  },
  {
    heading: 'فصل سوم: الزامات خارج از قرارداد',
    blocks: [
      { text: 'نکته ۶: غصب', bold: true },
      { text: 'غصب استیلا بر حق غیر است به نحو عدوان. اثبات ید بر مال غیر بدون مجوز هم در حکم غصب است.' },
      { text: 'نکته ۷: اتلاف', bold: true },
      { text: 'هر کس مال غیر را تلف کند ضامن آن است و باید مثل یا قیمت آن را بدهد، اعم از اینکه از روی عمد تلف کرده باشد یا بدون عمد.' },
    ],
    flags: [],
  },
];

const notesPages: PageLayout[] = [];
const notesText: string[] = [];

(function buildNotes() {
  NOTES.forEach((n, i) => {
    const page: PageLayout = { doc: 'booklet', index: i, lines: [], heading: n.heading };
    let y = 230;
    for (const b of n.blocks) {
      const ls = layoutText(b.text, y, 0, undefined, undefined);
      if (b.bold) ls.forEach((l) => (l.bold = true));
      page.lines.push(...ls);
      y += ls.length * LINE_H + (b.bold ? 4 : 20);
    }
    for (const f of n.flags) {
      for (const l of page.lines) {
        const w = l.words.find((x) => x.text.replace(/[.،؛:]$/, '') === f.word && !x.flag);
        if (w) {
          w.flag = f.reason;
          w.alt = f.alt ?? null;
          w.conf = f.reason === 'low_conf' ? 38 : 70;
          break;
        }
      }
    }
    notesPages.push(page);
    notesText.push([n.heading, ...n.blocks.map((b) => b.text)].join('\n\n'));
  });
})();

/** The auto-reflowed OCR text of a notes page (what GET …/text returns before edits). */
export function notesPageText(index: number): string {
  return notesText[index] ?? '';
}

export function makeTextProject(id: string, title: string, createdAt: string): Project {
  return {
    id, title, track: 'other', year: null, blueprint: 'auto', doc_type: 'text', mode: 'text', engine: 'auto',
    created_at: createdAt, status: 'ready', progress: { stage: 'done', done: NOTES.length, total: NOTES.length },
    error: null,
    documents: [{ kind: 'booklet', filename: 'bank-nokat-madani.pdf', page_count: NOTES.length }],
    questions: [], issues: [], page_status: { 'booklet:0': true },
  };
}

// ---------------------------------------------------------------- questions

export function validateQuestion(q: Question, hasExplanations: boolean): Issue[] {
  // Mirrors backend/app/validate.py codes, levels and fields.
  const issues: Issue[] = [];
  if (!q.stem.trim()) issues.push({ level: 'error', code: 'empty_stem', message: 'صورت سؤال خالی است.', field: 'stem' });
  if (q.options.length !== 4) {
    issues.push({ level: 'error', code: 'option_count', message: `تعداد گزینه‌ها ${fa(q.options.length)} است (باید ۴ باشد).`, field: null });
  }
  for (const o of q.options) {
    if (!o.text.trim()) issues.push({ level: 'error', code: 'empty_option', message: `متن گزینه ${fa(o.key)} خالی است.`, field: `option:${o.key}` });
  }
  if (!q.correct_key) issues.push({ level: 'error', code: 'missing_key', message: 'کلید (گزینه صحیح) مشخص نیست.', field: null });
  if (hasExplanations && !q.explanation.trim()) {
    issues.push({ level: 'warning', code: 'missing_explanation', message: 'پاسخ تشریحی پیدا نشد.', field: 'explanation' });
  }
  if ((q.duplicates ?? []).length) issues.push({ level: 'warning', code: 'duplicate', message: 'این سؤال تکراری به نظر می‌رسد.', field: null });
  if (q.flags.length) issues.push({ level: 'warning', code: 'suspicious_words', message: `${fa(q.flags.length)} کلمه مشکوک`, field: null });
  if (!q.subject_key) issues.push({ level: 'warning', code: 'missing_subject', message: 'درس سؤال مشخص نیست.', field: null });
  return issues;
}

export function seedQuestions(): Question[] {
  return SEED.map((s) => {
    const q: Question = {
      number: s.number,
      subject_key: s.subject,
      stem: s.stem,
      options: s.options.map((t, i) => ({ key: String(i + 1), text: t })),
      correct_key: s.key,
      key_source: s.number === 9 ? 'inline' : s.keySource,
      source_ref: s.number === 3 ? 'ارشد سراسری-۷۸' : s.number === 9 ? 'وکالت ۱۴۰۰' : '',
      ...seedClassification(s.number),
      explanation: s.explanation,
      regions: (regionsByQ.get(s.number) ?? []).map((r) => ({ doc: r.doc, page: r.page, bbox: norm(r.px) })),
      flags: structuredClone(flagsByQ.get(s.number) ?? []),
      issues: [],
      status: s.number === 1 || s.number === 10 ? 'approved' : 'pending',
      edited: false,
    };
    q.issues = validateQuestion(q, true);
    return q;
  });
}

export function seedProjectIssues(): Issue[] {
  return [
    { level: 'error', code: 'missing_numbers', message: 'سؤال‌های یافت‌نشده: ۸', field: null },
    { level: 'warning', code: 'count_mismatch', message: 'تعداد سؤال‌های یافته‌شده (۱۰) با الگوی آزمون (۱۴۰) هم‌خوانی ندارد.', field: null },
  ];
}

export function makeReadyProject(id: string, title: string, createdAt: string): Project {
  return {
    id, title, track: 'bar', year: 1403, blueprint: 'BAR-1405', doc_type: 'auto', mode: 'questions', page_status: {},
    engine: 'auto', created_at: createdAt,
    status: 'ready', progress: { stage: 'done', done: 3, total: 3 }, error: null,
    stats: {
      pages: 3, started_at: new Date(Date.parse(createdAt || '2026-01-01') ).toISOString(),
      finished_at: new Date(Date.parse(createdAt || '2026-01-01') + 95_000).toISOString(),
      ocr_seconds: 80, parse_seconds: 15, engine: 'claude+tesseract', ai_pages: 2,
      ai_usage: { calls: 4, cached: 3, input_tokens: 9800, output_tokens: 2600 }, ai_cost_usd: 0.087,
    },
    documents: [
      { kind: 'booklet', filename: 'kanoon-1403-camscanner.pdf', page_count: pageCount('booklet') },
      { kind: 'explanations', filename: 'pasokh-tashrihi-1403.pdf', page_count: pageCount('explanations') },
    ],
    questions: seedQuestions(),
    issues: seedProjectIssues(),
  };
}

// ---------------------------------------------------------- classification

type Art = NonNullable<Question['articles']>[number];
const art = (law_key: string, law: string, number: string, source: Art['source'], kind: Art['kind'] = 'ماده', clause = ''): Art => ({
  law_key, law, kind, number, clause, source, field: 'explanation',
});

function seedClassification(n: number): Pick<Question, 'topic' | 'articles' | 'classification'> {
  const c = (topic: string, ts: Art['source'] | null, conf: number | null, articles: Art[], path: string[] = []) => ({
    topic,
    articles,
    classification: { subject_source: 'blueprint' as const, subject_confidence: 0.9, topic_source: ts, topic_confidence: conf, section_path: path },
  });
  switch (n) {
    case 1: return c('عقد بیع', 'rules', 0.8, [art('civil_code', 'قانون مدنی', '۳۶۱', 'text')], ['جلد دوم', 'فصل اول: بیع']);
    case 2: return c('عقد اجاره', 'heading', 0.95, [art('civil_code', 'قانون مدنی', '۴۷۴', 'text')], ['جلد دوم', 'فصل چهارم: اجاره']);
    case 3: return c('خیارات', 'ai', 0.55, [art('civil_code', 'قانون مدنی', '۴۰۲', 'text')]);
    case 4: return c('صلاحیت دادگاه‌ها', 'rules', 0.7, [art('civil_procedure_code', 'قانون آیین دادرسی مدنی', '۱۲', 'text')]);
    case 5: return c('', null, null, [art('civil_procedure_code', 'قانون آیین دادرسی مدنی', '۳۳۶', 'text')]);
    case 6: return c('شروع به جرم', 'manual', 1, [art('penal_code', 'قانون مجازات اسلامی', '۱۲۲', 'text')]);
    case 7: return c('', null, null, []);
    case 9: return c('قرارهای تأمین', 'rules', 0.65, [art('criminal_procedure_code', 'قانون آیین دادرسی کیفری', '۲۴۰', 'text')]);
    case 10: return c('اسناد تجاری', 'heading', 0.9, [art('commercial_code', 'قانون تجارت', '۲۲۳', 'rules')]);
    default: return c('', null, null, []);
  }
}

const KEYWORDS: { re: RegExp; subject: string; topic: string; article?: Art }[] = [
  { re: /سهامی|شرکت/, subject: 'commercial', topic: 'شرکت‌های تجاری' },
  { re: /علل موجهه|دفاع مشروع/, subject: 'criminal', topic: 'علل موجهه‌ی جرم', article: art('penal_code', 'قانون مجازات اسلامی', '۱۵۶', 'rules') },
  { re: /تجدیدنظر/, subject: 'civil_procedure', topic: 'تجدیدنظر' },
  { re: /اجاره|مستأجر|مستاجر/, subject: 'civil', topic: 'عقد اجاره' },
  { re: /بیع|مبیع/, subject: 'civil', topic: 'عقد بیع' },
];

/** Tiny offline classifier for the mock: never overwrites manual fields. */
export function classifyQuestion(q: Question): void {
  const text = `${q.stem} ${q.options.map((o) => o.text).join(' ')} ${q.explanation}`;
  const hit = KEYWORDS.find((k) => k.re.test(text));
  q.classification = q.classification ?? { subject_source: null, subject_confidence: null, topic_source: null, topic_confidence: null, section_path: [] };
  if (!hit) return;
  if (q.classification.subject_source !== 'manual' && !q.subject_key) {
    q.subject_key = hit.subject;
    q.classification.subject_source = 'rules';
    q.classification.subject_confidence = 0.7;
  }
  if (q.classification.topic_source !== 'manual' && !(q.topic ?? '').trim()) {
    q.topic = hit.topic;
    q.classification.topic_source = 'rules';
    q.classification.topic_confidence = 0.7;
  }
  if (hit.article && !(q.articles ?? []).some((a) => a.number === hit.article!.number && a.law_key === hit.article!.law_key)) {
    q.articles = [...(q.articles ?? []), hit.article];
  }
}
