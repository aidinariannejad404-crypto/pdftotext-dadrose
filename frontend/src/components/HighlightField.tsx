import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Flag } from '../types';
import { computeMarks, cx, type MarkRange } from '../util';

interface Props {
  id: string;
  field: string;
  value: string;
  flags: Flag[];
  onChange: (v: string) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  register?: (field: string, el: HTMLTextAreaElement | null) => void;
  activeFlagIndex?: number | null;
  placeholder?: string;
  label: string; // accessible label (visually provided elsewhere)
  labelledBy?: string;
  invalid?: boolean;
  compact?: boolean;
  onMarkClick?: (m: MarkRange) => void;
}

interface Tip {
  x: number;
  y: number;
  mark: MarkRange;
}

/**
 * Auto-growing textarea with inline highlights for flagged words.
 *
 * Mirror technique: a backdrop div with identical box metrics renders the same
 * text (transparent) with <mark>s; the textarea sits on top with a transparent
 * background. Both live in the same CSS grid cell, so the backdrop's content
 * height drives the field height (auto-grow without measuring).
 */
export default function HighlightField({
  id, field, value, flags, onChange, onBlur, onFocus, register, activeFlagIndex, placeholder, label, labelledBy,
  invalid, compact, onMarkClick,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  const marks = computeMarks(value, flags, field);

  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      taRef.current = el;
      register?.(field, el);
    },
    [field, register],
  );

  // Keep scroll in sync (normally 0 since the field auto-grows, but IME/resize can scroll).
  const syncScroll = () => {
    if (taRef.current && backRef.current) {
      backRef.current.scrollTop = taRef.current.scrollTop;
      backRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };
  useLayoutEffect(syncScroll, [value]);

  const segments: ReactNode[] = [];
  let pos = 0;
  marks.forEach((m, i) => {
    if (m.start > pos) segments.push(value.slice(pos, m.start));
    segments.push(
      <mark
        key={i}
        data-mark={i}
        className={cx('hl-mark', `hl-${m.flag.reason}`, activeFlagIndex === m.flagIndex && 'is-active')}
      >
        {value.slice(m.start, m.end)}
      </mark>,
    );
    pos = m.end;
  });
  segments.push(value.slice(pos));
  // A trailing newline needs an extra character to take up a line in the mirror.
  segments.push('​');

  const markAt = (clientX: number, clientY: number): MarkRange | null => {
    const els = document.elementsFromPoint(clientX, clientY);
    for (const el of els) {
      if (el instanceof HTMLElement && el.dataset.mark !== undefined && backRef.current?.contains(el)) {
        return marks[Number(el.dataset.mark)] ?? null;
      }
    }
    return null;
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const m = markAt(e.clientX, e.clientY);
    if (!m) {
      if (tip) setTip(null);
      return;
    }
    const host = backRef.current?.parentElement?.getBoundingClientRect();
    const el = backRef.current?.querySelector<HTMLElement>(`[data-mark="${marks.indexOf(m)}"]`);
    const r = el?.getBoundingClientRect();
    if (!host || !r) return;
    if (tip && tip.mark.start === m.start && tip.mark.end === m.end) return;
    setTip({ x: r.left + r.width / 2 - host.left, y: r.top - host.top, mark: m });
  };

  return (
    <div
      className={cx('hl-field', compact && 'is-compact', invalid && 'is-invalid')}
      onMouseLeave={() => setTip(null)}
    >
      <div className="hl-backdrop" ref={backRef} aria-hidden="true">
        {segments}
      </div>
      <textarea
        id={id}
        ref={setRef}
        className="hl-input"
        value={value}
        rows={1}
        dir="rtl"
        spellCheck={false}
        placeholder={placeholder}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-invalid={invalid || undefined}
        data-field={field}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onBlur={onBlur}
        onFocus={onFocus}
        onMouseMove={onMouseMove}
        onClick={(e) => {
          const m = markAt(e.clientX, e.clientY);
          if (m && onMarkClick) onMarkClick(m);
        }}
      />
      {tip && (
        <div className="hl-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.mark.flag.reason === 'disagree' ? (
            <>
              <span className="hl-tip-title">اختلاف دو موتور</span>
              <span>
                خوانش دیگر: <b dir="auto">{tip.mark.flag.alt || '—'}</b>
              </span>
            </>
          ) : (
            <span className="hl-tip-title">اطمینان پایین OCR</span>
          )}
        </div>
      )}
    </div>
  );
}
