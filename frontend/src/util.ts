import type { Flag, Issue, Question } from './types';

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** Render ASCII digits as Persian digits (numbers, or strings containing digits). */
export function fa(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}

export function toAsciiDigits(s: string): string {
  return s
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

export function percent(done: number, total: number): number {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

export const STAGE_LABELS: Record<string, string> = {
  queued: 'در صف',
  rendering: 'تبدیل صفحات',
  ocr: 'خواندن متن (OCR)',
  parsing: 'تحلیل سؤال‌ها',
  done: 'پایان',
  failed: 'ناموفق',
};

export const STATUS_LABELS: Record<string, string> = {
  queued: 'در صف',
  processing: 'در حال پردازش',
  ready: 'آماده‌ی بازبینی',
  failed: 'ناموفق',
};

export const TRACK_LABELS: Record<string, string> = {
  bar: 'کانون وکلا',
  center: 'مرکز وکلا',
  other: 'سایر',
};

export const ENGINE_LABELS: Record<string, string> = {
  auto: 'خودکار',
  offline: 'فقط آفلاین',
  claude: 'Claude',
  gemini: 'Gemini',
};

export const KEY_SOURCE_LABELS: Record<string, string> = {
  table: 'از جدول کلید',
  explanation: 'از پاسخ تشریحی',
  inline: 'از پاسخ زیر سؤال',
  manual: 'دستی',
};

export const DOC_LABELS: Record<string, string> = {
  booklet: 'دفترچه',
  explanations: 'پاسخ تشریحی',
};

export function fieldLabel(field: string | null | undefined): string {
  if (!field) return '';
  if (field === 'stem') return 'صورت سؤال';
  if (field === 'explanation') return 'پاسخ تشریحی';
  if (field === 'correct_key') return 'کلید';
  if (field === 'subject_key') return 'درس';
  if (field === 'source_ref') return 'منبع سؤال';
  const m = /^option:(\d)$/.exec(field);
  if (m) return `گزینه‌ی ${fa(m[1])}`;
  return field;
}

export function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function hasLevel(issues: Issue[], level: Issue['level']): boolean {
  return issues.some((i) => i.level === level);
}

export type QState = 'approved' | 'error' | 'warning' | 'neutral';

export function questionState(q: Question): QState {
  if (q.status === 'approved') return 'approved';
  if (hasLevel(q.issues, 'error')) return 'error';
  if (hasLevel(q.issues, 'warning') || q.flags.length > 0) return 'warning';
  return 'neutral';
}

export function getFieldText(
  q: Pick<Question, 'stem' | 'options' | 'explanation'> & { source_ref?: string },
  field: string,
): string {
  if (field === 'stem') return q.stem;
  if (field === 'source_ref') return q.source_ref ?? '';
  if (field === 'explanation') return q.explanation;
  const m = /^option:(\d)$/.exec(field);
  if (m) return q.options.find((o) => o.key === m[1])?.text ?? '';
  return '';
}

export interface MarkRange {
  start: number;
  end: number;
  flag: Flag;
  flagIndex: number; // index into question.flags
}

const LETTER = /[\p{L}\p{N}\p{M}]/u;

function isBoundary(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : '';
  const after = end < text.length ? text[end] : '';
  return !(before && LETTER.test(before)) && !(after && LETTER.test(after));
}

function findWord(text: string, word: string, from: number, taken: MarkRange[]): number {
  let idx = text.indexOf(word, from);
  let loose = -1;
  while (idx !== -1) {
    const end = idx + word.length;
    const overlaps = taken.some((r) => idx < r.end && end > r.start);
    if (!overlaps) {
      if (isBoundary(text, idx, end)) return idx;
      if (loose === -1) loose = idx;
    }
    idx = text.indexOf(word, idx + 1);
  }
  return loose;
}

/**
 * Locate each flag's word in the current text of its field, in order: every flag
 * claims the next free occurrence after the previous match (falling back to the
 * first free occurrence anywhere). Flags whose word is no longer present are skipped.
 */
export function computeMarks(text: string, flags: Flag[], field: string): MarkRange[] {
  const out: MarkRange[] = [];
  let cursor = 0;
  flags.forEach((flag, flagIndex) => {
    if (flag.field !== field || !flag.word) return;
    let idx = findWord(text, flag.word, cursor, out);
    if (idx === -1) idx = findWord(text, flag.word, 0, out);
    if (idx === -1) return;
    out.push({ start: idx, end: idx + flag.word.length, flag, flagIndex });
    cursor = idx + flag.word.length;
  });
  return out.sort((a, b) => a.start - b.start);
}

export function bboxContains(outer: readonly number[], inner: readonly number[], slack = 0.01): boolean {
  const cx = (inner[0] + inner[2]) / 2;
  const cy = (inner[1] + inner[3]) / 2;
  return cx >= outer[0] - slack && cx <= outer[2] + slack && cy >= outer[1] - slack && cy <= outer[3] + slack;
}

export function sameBox(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (!a || !b) return false;
  return a.every((v, i) => Math.abs(v - b[i]) < 0.002);
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => t && clearTimeout(t);
  return wrapped;
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ------------------------------------------------------------ issue helpers

/** Where an issue should be fixed: a field name, 'key' (radio group), 'subject', 'flags' or null. */
export function issueTarget(issue: Issue, q: Pick<Question, 'options'>): string | null {
  switch (issue.code) {
    case 'missing_key':
    case 'invalid_key':
      return 'key';
    case 'key_mismatch':
      return 'key';
    case 'missing_subject':
      return 'subject';
    case 'suspicious_words':
      return 'flags';
    case 'empty_stem':
      return 'stem';
    case 'missing_explanation':
      return 'explanation';
    case 'option_count': {
      const empty = ['1', '2', '3', '4'].find((k) => !q.options.find((o) => o.key === k)?.text.trim());
      return empty ? `option:${empty}` : 'key';
    }
    default:
      if (issue.field === 'correct_key') return 'key';
      if (issue.field === 'subject_key') return 'subject';
      return issue.field ?? null;
  }
}

/** A friendly, actionable sentence for an issue (falls back to the server message). */
export function issueAction(issue: Issue): string {
  const opt = /^option:(\d)$/.exec(issue.field ?? '');
  switch (issue.code) {
    case 'missing_key':
      return 'گزینه‌ی درست مشخص نیست — روی دایره‌ی کنار گزینه‌ی درست بزنید.';
    case 'invalid_key':
      return 'کلید با گزینه‌ها جور نیست — گزینه‌ی درست را دوباره انتخاب کنید.';
    case 'key_mismatch':
      return `${issue.message} گزینه‌ی درست را بررسی و انتخاب کنید.`;
    case 'empty_option':
      return opt ? `متن گزینه‌ی ${fa(opt[1])} خالی است — آن را از روی تصویر وارد کنید.` : issue.message;
    case 'empty_stem':
      return 'صورت سؤال خالی است — آن را از روی تصویر وارد کنید.';
    case 'option_count':
      return `${issue.message} گزینه‌ی جاافتاده را از روی تصویر وارد کنید.`;
    case 'missing_subject':
      return 'درس این سؤال مشخص نیست — از فهرست بالا انتخاب کنید.';
    case 'missing_explanation':
      return 'پاسخ تشریحی پیدا نشد — در صورت نیاز از روی تصویر وارد کنید (اختیاری).';
    case 'suspicious_words':
      return `${issue.message} — هر کدام را پایین‌تر تأیید یا اصلاح کنید.`;
    default:
      return issue.message;
  }
}

export function setFieldText<T extends { stem: string; explanation: string; options: { key: string; text: string }[] }>(
  d: T,
  field: string,
  text: string,
): Partial<T> {
  if (field === 'stem') return { stem: text } as Partial<T>;
  if (field === 'source_ref') return { source_ref: text } as unknown as Partial<T>;
  if (field === 'explanation') return { explanation: text } as Partial<T>;
  const m = /^option:(\d)$/.exec(field);
  if (m) return { options: d.options.map((o) => (o.key === m[1] ? { ...o, text } : o)) } as Partial<T>;
  return {};
}

/** Rough processing-time estimate for the remaining pages (5–15 s per page). */
export function etaText(pages: number): string {
  if (pages <= 0) return 'چند لحظه';
  const lo = Math.ceil((pages * 5) / 60);
  const hi = Math.ceil((pages * 15) / 60);
  if (hi <= 1) return 'کمتر از یک دقیقه';
  if (lo === hi) return `حدود ${fa(hi)} دقیقه`;
  return `حدود ${fa(lo)} تا ${fa(hi)} دقیقه`;
}

export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

// ------------------------------------------------------------ classification

export const CLASS_SOURCE_LABELS: Record<string, string> = {
  text: 'از متن',
  heading: 'از سرفصل',
  blueprint: 'الگوی آزمون',
  rules: 'کلیدواژه',
  ai: 'هوش مصنوعی',
  manual: 'دستی',
  default: 'پیش‌فرض',
};

export function articleLabel(a: { kind: string; number: string; clause: string; law: string }): string {
  const head = `${a.kind} ${fa(a.number)}${a.clause ? ` ${fa(a.clause)}` : ''}`;
  return a.law ? `${head} · ${a.law}` : head;
}

/** Comparable form for search: ASCII digits, no ZWNJ/diacritics, lower-case. */
export function searchable(s: string): string {
  return toAsciiDigits(s)
    .replace(/[\u200c\u064b-\u065f]/g, '')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .toLowerCase();
}

// ------------------------------------------------------------- high volume

export function durationText(seconds: number): string {
  if (!seconds || seconds < 1) return '';
  if (seconds < 60) return `${fa(Math.round(seconds))} ثانیه`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${fa(m)} دقیقه`;
  return `${fa(Math.floor(m / 60))} ساعت و ${fa(m % 60)} دقیقه`;
}

const ENGINE_PRETTY: Record<string, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  tesseract: 'Tesseract',
  text_layer: 'لایه‌ی متنی PDF',
  offline: 'آفلاین',
};

export function statsText(s: { pages: number; started_at: string | null; finished_at: string | null; ocr_seconds: number; parse_seconds: number; engine: string } | null | undefined): string {
  if (!s) return '';
  const parts: string[] = [];
  if (s.pages) parts.push(`${fa(s.pages)} صفحه`);
  let secs = s.ocr_seconds + s.parse_seconds;
  if (s.started_at && s.finished_at) {
    const d = (new Date(s.finished_at).getTime() - new Date(s.started_at).getTime()) / 1000;
    if (d > 0) secs = d;
  }
  const dur = durationText(secs);
  if (dur) parts.push(dur);
  if (s.engine) parts.push(s.engine.split('+').map((e) => ENGINE_PRETTY[e] ?? e).join('+'));
  return parts.join(' · ');
}

export const ISSUE_CODE_LABELS: Record<string, string> = {
  empty_stem: 'صورت سؤال خالی',
  option_count: 'تعداد گزینه‌ها',
  empty_option: 'گزینه‌ی خالی',
  missing_key: 'بدون کلید',
  invalid_key: 'کلید نامعتبر',
  key_mismatch: 'مغایرت کلید',
  missing_explanation: 'بدون پاسخ تشریحی',
  suspicious_words: 'کلمه‌ی مشکوک',
  merged_suspect: 'ادغام احتمالی',
  missing_subject: 'بدون درس',
  duplicate: 'تکراری',
  duplicate_question: 'تکراری',
};

const LETTER_KEYS: Record<string, string> = { الف: '1', ب: '2', ج: '3', د: '4' };

/**
 * Parse a typed answer-key string. Digits 1–4 (Persian/ASCII) are keys; 0, "-" and spaces
 * skip a question (null). When الف/ب/ج/د appear, tokens are whitespace-separated instead.
 */
export function parseKeys(raw: string): (string | null)[] {
  const s = toAsciiDigits(raw).trim();
  if (!s) return [];
  if (/الف|(^|\s)[بجد](\s|$)/.test(s)) {
    return s.split(/\s+/).map((t) => LETTER_KEYS[t] ?? (/^[1-4]$/.test(t) ? t : null));
  }
  const out: (string | null)[] = [];
  for (const ch of s) {
    if (/[1-4]/.test(ch)) out.push(ch);
    else if (ch === '0' || ch === '-' || ch === ' ' || ch === '_') out.push(null);
    // other characters (commas, newlines…) are ignored
  }
  return out;
}
