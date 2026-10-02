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
const CHAR_W = 11.2;
const SPACE_W = 9;

export const META: Meta = {
  blueprints: [
    { code: 'bar-1403', title: 'کانون وکلا ۱۴۰۳', track: 'bar', year: 1403, question_count: 150 },
    { code: 'bar-1402', title: 'کانون وکلا ۱۴۰۲', track: 'bar', year: 1402, question_count: 150 },
    { code: 'center-1403', title: 'مرکز وکلا ۱۴۰۳', track: 'center', year: 1403, question_count: 140 },
    { code: 'mock-12', title: 'نمونه‌ی ۱۲ سؤالی (ماک)', track: 'bar', year: 1404, question_count: 12 },
  ],
  subjects: [
    { key: 'civil', name: 'حقوق مدنی' },
    { key: 'civil_procedure', name: 'آیین دادرسی مدنی' },
    { key: 'criminal', name: 'حقوق جزا' },
    { key: 'criminal_procedure', name: 'آیین دادرسی کیفری' },
    { key: 'commercial', name: 'حقوق تجارت' },
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

export function pageResult(doc: DocKind, index: number): PageResult | null {
  const page = pages.find((p) => p.doc === doc && p.index === index);
  if (!page) return null;
  const lines: Line[] = page.lines.map((l) => ({
    page: index,
    bbox: norm(unionPx(l.words)),
    words: l.words.map((w) => ({ text: w.text, bbox: norm(w.px), conf: w.conf, flag: w.flag, alt: w.alt })),
  }));
  return {
    index, width: PAGE_W, height: PAGE_H, source: 'ocr', engine: 'claude+tesseract',
    preprocess: ['page_detect', 'perspective', 'deskew', 'shadow_removal', 'contrast'],
    lines,
    warnings: doc === 'booklet' && index === 1 ? ['کیفیت اسکن پایین است؛ برخی کلمات با اطمینان کم خوانده شدند.'] : [],
  };
}

export function pageCount(doc: DocKind): number {
  return pages.filter((p) => p.doc === doc).length;
}

let fontDataUri: string | null = null;
export function setFontData(b64: string) {
  fontDataUri = `data:font/woff2;base64,${b64}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** SVG standing in for the page JPEG. `orig` simulates the raw phone scan. */
export function pageSvg(doc: DocKind, index: number, orig: boolean): string | null {
  const page = pages.find((p) => p.doc === doc && p.index === index);
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

// ---------------------------------------------------------------- questions

export function validateQuestion(q: Question, hasExplanations: boolean): Issue[] {
  const issues: Issue[] = [];
  if (!q.stem.trim()) issues.push({ level: 'error', code: 'empty_stem', message: 'صورت سؤال خالی است.', field: 'stem' });
  if (q.options.length !== 4) issues.push({ level: 'error', code: 'option_count', message: 'سؤال باید دقیقاً ۴ گزینه داشته باشد.', field: null });
  for (const o of q.options) {
    if (!o.text.trim()) issues.push({ level: 'error', code: 'empty_option', message: `گزینه‌ی ${fa(o.key)} خالی است.`, field: `option:${o.key}` });
  }
  if (!q.correct_key) issues.push({ level: 'error', code: 'missing_key', message: 'کلید سؤال در جدول کلید پیدا نشد.', field: 'correct_key' });
  if (!q.subject_key) issues.push({ level: 'warning', code: 'missing_subject', message: 'درس سؤال مشخص نیست.', field: 'subject_key' });
  if (hasExplanations && !q.explanation.trim()) {
    issues.push({ level: 'warning', code: 'missing_explanation', message: 'پاسخ تشریحی این سؤال پیدا نشد.', field: 'explanation' });
  }
  const texts = q.options.map((o) => o.text.trim()).filter(Boolean);
  if (new Set(texts).size !== texts.length) issues.push({ level: 'warning', code: 'duplicate_options', message: 'دو گزینه متن یکسان دارند.', field: null });
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
      key_source: s.keySource,
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
    { level: 'error', code: 'missing_numbers', message: 'سؤال شماره‌ی ۸ در دفترچه پیدا نشد.', field: null },
    { level: 'warning', code: 'count_mismatch', message: 'تعداد سؤال‌های یافته‌شده (۱۰) با الگوی آزمون (۱۲) هم‌خوانی ندارد.', field: null },
  ];
}

export function makeReadyProject(id: string, title: string, createdAt: string): Project {
  return {
    id, title, track: 'bar', year: 1403, blueprint: 'mock-12', engine: 'auto', created_at: createdAt,
    status: 'ready', progress: { stage: 'done', done: 3, total: 3 }, error: null,
    documents: [
      { kind: 'booklet', filename: 'kanoon-1403-camscanner.pdf', page_count: pageCount('booklet') },
      { kind: 'explanations', filename: 'pasokh-tashrihi-1403.pdf', page_count: pageCount('explanations') },
    ],
    questions: seedQuestions(),
    issues: seedProjectIssues(),
  };
}
