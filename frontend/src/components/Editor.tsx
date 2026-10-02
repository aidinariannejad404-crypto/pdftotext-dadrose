import { useId, useState, type ReactNode } from 'react';
import { useAppData } from '../appData';
import type { Flag, Issue, Question } from '../types';
import type { Draft, SaveState } from '../useDraft';
import { KEY_SOURCE_LABELS, computeMarks, cx, fa, fieldLabel, getFieldText, issueAction, issueTarget, type MarkRange } from '../util';
import HighlightField from './HighlightField';
import { Icon } from './Icons';

export interface NextProblem {
  label: string;
  count: number;
  disabled: boolean;
  tone: 'error' | 'warning' | 'neutral' | 'done';
  onClick: () => void;
}

interface Props {
  question: Question;
  draft: Draft;
  saveState: SaveState;
  activeFlagIndex: number | null;
  onChange: (patch: Partial<Draft>, immediate?: boolean) => void;
  onOption: (key: string, text: string) => void;
  onBlurField: () => void;
  onSave: () => void;
  onApprove: () => void;
  onUnapprove: () => void;
  onReocr: () => void;
  onDelete: () => void;
  onAdd: () => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  onFlagClick: (flag: Flag, index: number) => void;
  onFlagHover: (index: number | null) => void;
  onResolveFlag: (index: number, useAlt: boolean, field?: string) => void;
  onDropFlags: (indices: number[]) => void;
  onIssueClick: (target: string | null) => void;
  register: (field: string, el: HTMLTextAreaElement | null) => void;
  index: number;
  total: number;
  reocrBusy: boolean;
  hasExplanations: boolean;
  nextProblem: NextProblem;
  banner?: ReactNode;
}

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'ذخیره شد',
  dirty: 'در انتظار ذخیره…',
  saving: 'در حال ذخیره…',
  error: 'ذخیره نشد',
};

export function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry?: () => void }) {
  return (
    <span className={`save-state save-${state}`} role="status" aria-live="polite" data-testid="save-state">
      <i className="save-dot" aria-hidden="true" />
      {SAVE_LABEL[state]}
      {state === 'error' && onRetry && (
        <button className="link" onClick={onRetry}>
          تلاش دوباره
        </button>
      )}
    </span>
  );
}

export function NextProblemButton({ np, className }: { np: NextProblem; className?: string }) {
  return (
    <button
      className={cx('btn btn-next-problem', `np-${np.tone}`, className)}
      onClick={np.onClick}
      disabled={np.disabled}
      title="رفتن به سؤال بعدی که نیاز به بررسی دارد (F8 یا Alt+N)"
      data-testid="next-problem"
    >
      <Icon name="alert" size={16} /> {np.label}
      {np.count > 0 && <span className="np-count">{fa(np.count)}</span>}
    </button>
  );
}

function FieldIssues({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="field-issues">
      {issues.map((i, k) => (
        <li key={k} className={`field-issue field-issue-${i.level}`}>
          <Icon name="alert" size={14} /> {issueAction(i)}
        </li>
      ))}
    </ul>
  );
}

const FIELD_ORDER = ['stem', 'option:1', 'option:2', 'option:3', 'option:4', 'source_ref', 'explanation'];
const MAX_VISIBLE = 4;

interface PlacedFlag {
  flag: Flag;
  index: number; // index in draft.flags
  field: string; // where the word currently is ('source_ref' if it moved there)
}

/** Decide where each flag's word currently lives; flags whose word vanished are returned as `stale`. */
export function placeFlags(draft: Draft): { placed: PlacedFlag[]; stale: number[] } {
  const placed: PlacedFlag[] = [];
  const stale: number[] = [];
  draft.flags.forEach((flag, index) => {
    const text = getFieldText(draft, flag.field);
    const present = computeMarks(text, draft.flags, flag.field).some((m) => m.flagIndex === index);
    if (present) placed.push({ flag, index, field: flag.field });
    else if (draft.source_ref && draft.source_ref.includes(flag.word)) placed.push({ flag, index, field: 'source_ref' });
    else stale.push(index);
  });
  placed.sort((x, y) => FIELD_ORDER.indexOf(x.field) - FIELD_ORDER.indexOf(y.field) || x.index - y.index);
  return { placed, stale };
}

function FlagRow({
  p, active, onLocate, onHover, onResolve,
}: {
  p: PlacedFlag;
  active: boolean;
  onLocate: () => void;
  onHover: (i: number | null) => void;
  onResolve: (useAlt: boolean) => void;
}) {
  const { flag, index } = p;
  const hasAlt = flag.reason === 'disagree' && !!flag.alt;
  return (
    <li
      className={cx('flag-row', `flag-${flag.reason}`, active && 'is-active')}
      onMouseEnter={() => onHover(index)}
      onMouseLeave={() => onHover(null)}
      data-testid="flag-chip"
    >
      <button
        className="flag-word"
        onClick={onLocate}
        onFocus={() => onHover(index)}
        onBlur={() => onHover(null)}
        title={hasAlt ? `دو خوانش: «${flag.word}» یا «${flag.alt}» — نمایش در متن و تصویر` : 'در تصویر خوانا نبود — نمایش در متن و تصویر'}
      >
        <b>{flag.word}</b>
        {hasAlt ? <span className="flag-alt">یا {flag.alt}؟</span> : <span className="flag-why">خوانا نبود</span>}
        <span className="flag-where">{fieldLabel(p.field === 'source_ref' ? 'source_ref' : flag.field)}</span>
      </button>
      <button
        className="btn btn-xs btn-icon flag-ok"
        onClick={() => onResolve(false)}
        title={`«${flag.word}» درست است`}
        aria-label={`«${flag.word}» درست است`}
        data-testid="flag-keep"
      >
        <Icon name="check" size={15} />
      </button>
      {hasAlt && (
        <button
          className="btn btn-xs btn-alt flag-swap"
          onClick={() => onResolve(true)}
          title={`جایگزینی با «${flag.alt}»`}
          aria-label={`جایگزینی با «${flag.alt}»`}
          data-testid="flag-use-alt"
        >
          ⇄ {flag.alt}
        </button>
      )}
    </li>
  );
}

function FlagsPanel({
  draft, activeFlagIndex, onFlagClick, onFlagHover, onResolveFlag, onDropFlags, labelId,
}: {
  draft: Draft;
  activeFlagIndex: number | null;
  onFlagClick: (flag: Flag, index: number) => void;
  onFlagHover: (index: number | null) => void;
  onResolveFlag: (index: number, useAlt: boolean, field?: string) => void;
  onDropFlags: (indices: number[]) => void;
  labelId: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const { placed, stale } = placeFlags(draft);
  if (placed.length === 0 && stale.length === 0) return null;
  const main = placed.filter((p) => p.field !== 'explanation');
  const expl = placed.filter((p) => p.field === 'explanation');
  const visible = showAll ? main : main.slice(0, MAX_VISIBLE);
  const row = (p: PlacedFlag) => (
    <FlagRow
      key={`${p.index}-${p.flag.word}`}
      p={p}
      active={activeFlagIndex === p.index}
      onLocate={() => onFlagClick(p.flag, p.index)}
      onHover={onFlagHover}
      onResolve={(alt) => onResolveFlag(p.index, alt, p.field)}
    />
  );
  return (
    <section className="flags-box" data-field="flags" tabIndex={-1} aria-labelledby={labelId}>
      <h3 id={labelId} className="flags-title">
        کلمات مشکوک ({fa(placed.length)})
        <span className="muted small"> — با تصویر مقایسه کنید: ✓ درست است، ⇄ جایگزینی</span>
      </h3>
      {main.length > 0 && <ul className="flag-list">{visible.map(row)}</ul>}
      {main.length > MAX_VISIBLE && (
        <button className="link small flags-more" onClick={() => setShowAll((v) => !v)} data-testid="flags-more">
          {showAll ? 'نمایش کمتر' : `نمایش همه (${fa(main.length)})`}
        </button>
      )}
      {expl.length > 0 && (
        <details className="flags-expl">
          <summary className="small">در پاسخ تشریحی ({fa(expl.length)})</summary>
          <ul className="flag-list">{expl.map(row)}</ul>
        </details>
      )}
      {stale.length > 0 && (
        <div className="small muted flags-stale">
          {fa(stale.length)} کلمه‌ی مشکوک دیگر در متن فعلی نیست.{' '}
          <button className="link" onClick={() => onDropFlags(stale)} data-testid="flags-drop-stale">
            حذف از فهرست
          </button>
        </div>
      )}
    </section>
  );
}

export default function Editor(props: Props) {
  const {
    question: q, draft, saveState, activeFlagIndex, onChange, onOption, onBlurField, onSave, onApprove, onUnapprove,
    onReocr, onDelete, onAdd, onPrev, onNext, hasPrev, hasNext, onFlagClick, onFlagHover, onResolveFlag, onDropFlags, onIssueClick,
    register, index, total, reocrBusy, hasExplanations, nextProblem, banner,
  } = props;
  const { meta } = useAppData();
  const uid = useId();
  const approved = q.status === 'approved';
  const flags = draft.flags;

  // Issues reflect the last save; hide ones the draft already fixed locally (key chosen, text typed).
  const issues = q.issues.filter((i) => {
    if ((i.code === 'missing_key' || i.code === 'invalid_key') && draft.correct_key) return i.code !== 'missing_key';
    if (i.code === 'missing_subject' && draft.subject_key) return false;
    if (i.code === 'suspicious_words' && flags.length === 0) return false;
    if (i.code === 'empty_option' && i.field) {
      const k = i.field.split(':')[1];
      return !draft.options.find((o) => o.key === k)?.text.trim();
    }
    if (i.code === 'empty_stem' && draft.stem.trim()) return false;
    return true;
  });
  const issuesFor = (target: string) => issues.filter((i) => issueTarget(i, draft) === target);
  const hasErrorAt = (target: string) => issuesFor(target).some((i) => i.level === 'error');
  // The suspicious-words box below is itself the call to action, so skip its summary issue.
  const listed = issues.filter((i) => i.code !== 'suspicious_words' || flags.length === 0);
  const sorted = [...listed.filter((i) => i.level === 'error'), ...listed.filter((i) => i.level === 'warning')];

  const markClick = (m: MarkRange) => onFlagClick(m.flag, m.flagIndex);
  const subjects = meta?.subjects ?? [];
  const knownSubject = !draft.subject_key || subjects.some((s) => s.key === draft.subject_key);
  const keyIssues = issuesFor('key');

  return (
    <section className="editor" aria-label={`ویرایش سؤال ${fa(q.number)}`}>
      <div className="editor-head">
        <div className="editor-title">
          <div className="btn-group" role="group" aria-label="جابه‌جایی بین سؤال‌ها">
            <button className="btn btn-sm btn-icon" onClick={onPrev} disabled={!hasPrev} title="سؤال قبلی (Alt+↑)" aria-label="سؤال قبلی">
              <Icon name="chev-right" />
            </button>
            <h2 className="qnum">
              سؤال <span data-testid="current-number">{fa(q.number)}</span>
            </h2>
            <button className="btn btn-sm btn-icon" onClick={onNext} disabled={!hasNext} title="سؤال بعدی (Alt+↓)" aria-label="سؤال بعدی">
              <Icon name="chev-left" />
            </button>
          </div>
          <span className="muted small">
            ({fa(index + 1)} از {fa(total)})
          </span>
          {approved && (
            <span className="chip chip-approved">
              <Icon name="check" size={14} /> تأییدشده
            </span>
          )}
        </div>
        <div className="editor-head-tools">
          <SaveIndicator state={saveState} onRetry={onSave} />
          <NextProblemButton np={nextProblem} className="btn-sm hide-mobile" />
        </div>
      </div>

      <div className="editor-scroll">
        {banner}

        {sorted.length > 0 && (
          <ul className="issues" aria-label="کارهای باقی‌مانده برای این سؤال">
            {sorted.map((i, idx) => (
              <li key={idx}>
                <button className={`issue issue-${i.level} issue-btn`} onClick={() => onIssueClick(issueTarget(i, draft))}>
                  <Icon name="alert" size={15} />
                  <span>{issueAction(i)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <FlagsPanel
          draft={draft}
          activeFlagIndex={activeFlagIndex}
          onFlagClick={onFlagClick}
          onFlagHover={onFlagHover}
          onResolveFlag={onResolveFlag}
          onDropFlags={onDropFlags}
          labelId={`${uid}-flags`}
        />
        <div className={cx('field-block', hasErrorAt('subject') && 'needs-attention-soft')}>
          <label className="field-label" htmlFor={`${uid}-subject`}>
            درس
          </label>
          <select
            id={`${uid}-subject`}
            data-field="subject"
            className={cx('input', !draft.subject_key && 'is-warning')}
            value={draft.subject_key ?? ''}
            onChange={(e) => onChange({ subject_key: e.target.value || null }, true)}
          >
            <option value="">— درس را انتخاب کنید —</option>
            {!knownSubject && <option value={draft.subject_key!}>{draft.subject_key}</option>}
            {subjects.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field-block">
          <label className="field-label" htmlFor={`${uid}-stem`}>
            صورت سؤال
          </label>
          <HighlightField
            id={`${uid}-stem`}
            field="stem"
            label="صورت سؤال"
            value={draft.stem}
            flags={flags}
            onChange={(v) => onChange({ stem: v })}
            onBlur={onBlurField}
            register={register}
            activeFlagIndex={activeFlagIndex}
            invalid={hasErrorAt('stem')}
            onMarkClick={markClick}
            placeholder="متن سؤال…"
          />
          <FieldIssues issues={issuesFor('stem')} />
          <label className="source-ref">
            <span className="field-label">منبع سؤال</span>
            <input
              className="input input-sm"
              value={draft.source_ref}
              onChange={(e) => onChange({ source_ref: e.target.value })}
              onBlur={onBlurField}
              placeholder="مثلاً ارشد سراسری-۷۸ (اختیاری)"
              data-field="source_ref"
            />
          </label>
        </div>

        <fieldset className={cx('options', keyIssues.some((i) => i.level === 'error') && 'needs-attention')} data-field="key">
          <legend className="field-label">
            گزینه‌ها — دایره‌ی کنار پاسخ درست را انتخاب کنید
            <span className={cx('key-source', !draft.correct_key && 'is-missing')}>
              {draft.correct_key
                ? `پاسخ درست: گزینه‌ی ${fa(draft.correct_key)}${q.key_source ? ` (${KEY_SOURCE_LABELS[q.key_source]})` : ''}`
                : 'پاسخ درست انتخاب نشده'}
            </span>
          </legend>
          <FieldIssues issues={keyIssues} />
          {draft.options.map((o) => {
            const field = `option:${o.key}`;
            const isKey = draft.correct_key === o.key;
            return (
              <div key={o.key}>
                <div className={cx('option-row', isKey && 'is-key')} data-testid={`option-${o.key}`}>
                  <label className="option-key" title="انتخاب به‌عنوان پاسخ درست">
                    <input
                      type="radio"
                      name={`${uid}-key`}
                      checked={isKey}
                      onChange={() => onChange({ correct_key: o.key }, true)}
                      aria-label={`گزینه‌ی ${fa(o.key)} پاسخ درست است`}
                      data-key-radio={o.key}
                    />
                    <span className="option-num">{fa(o.key)}</span>
                  </label>
                  <HighlightField
                    id={`${uid}-${field}`}
                    field={field}
                    label={`متن گزینه‌ی ${fa(o.key)}`}
                    value={o.text}
                    flags={flags}
                    onChange={(v) => onOption(o.key, v)}
                    onBlur={onBlurField}
                    register={register}
                    activeFlagIndex={activeFlagIndex}
                    invalid={hasErrorAt(field)}
                    compact
                    onMarkClick={markClick}
                    placeholder={`متن گزینه‌ی ${fa(o.key)}`}
                  />
                </div>
                <FieldIssues issues={issuesFor(field)} />
              </div>
            );
          })}
        </fieldset>

        <div className="field-block">
          <label className="field-label" htmlFor={`${uid}-explanation`}>
            پاسخ تشریحی <span className="muted small">(اختیاری{!hasExplanations && ' — فایل پاسخ تشریحی بارگذاری نشده'})</span>
          </label>
          <HighlightField
            id={`${uid}-explanation`}
            field="explanation"
            label="پاسخ تشریحی"
            value={draft.explanation}
            flags={flags}
            onChange={(v) => onChange({ explanation: v })}
            onBlur={onBlurField}
            register={register}
            activeFlagIndex={activeFlagIndex}
            invalid={hasErrorAt('explanation')}
            onMarkClick={markClick}
            placeholder="توضیح پاسخ…"
          />
          <FieldIssues issues={issuesFor('explanation')} />
        </div>

      </div>

      <div className="editor-actions">
        <button className="btn btn-success btn-approve" onClick={onApprove} title="Ctrl+Enter" data-testid="approve">
          <Icon name="check" /> {approved ? 'سؤال بعدی' : 'تأیید و بعدی'} <kbd>Ctrl+↵</kbd>
        </button>
        {approved && (
          <button className="btn btn-sm btn-ghost" onClick={onUnapprove}>
            لغو تأیید
          </button>
        )}
        {saveState !== 'saved' && (
          <button className="btn" onClick={onSave} disabled={saveState === 'saving'}>
            <Icon name="save" /> ذخیره
          </button>
        )}
        <span className="spacer" />
        <button
          className="btn btn-sm btn-ghost"
          onClick={onReocr}
          disabled={reocrBusy || q.regions.length === 0}
          title={q.regions.length === 0 ? 'این سؤال ناحیه‌ای روی تصویر ندارد' : 'متن این سؤال دوباره از روی تصویر خوانده می‌شود'}
        >
          <Icon name="sparkle" size={16} /> {reocrBusy ? 'در حال بازخوانی…' : 'بازخوانی با هوش مصنوعی'}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onAdd} title="افزودن سؤال جاافتاده">
          <Icon name="plus" size={16} /> افزودن سؤال
        </button>
        <button className="btn btn-sm btn-ghost btn-danger-text" onClick={onDelete} title="حذف این سؤال">
          <Icon name="trash" size={16} /> حذف
        </button>
      </div>
    </section>
  );
}
