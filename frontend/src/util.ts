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

export function getFieldText(q: Pick<Question, 'stem' | 'options' | 'explanation'>, field: string): string {
  if (field === 'stem') return q.stem;
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
