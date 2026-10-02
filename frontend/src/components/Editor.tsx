import { useId, type ReactNode } from 'react';
import { useAppData } from '../appData';
import type { Flag, Issue, Question } from '../types';
import type { Draft, SaveState } from '../useDraft';
import { KEY_SOURCE_LABELS, cx, fa, fieldLabel, issueAction, issueTarget, type MarkRange } from '../util';
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
  onResolveFlag: (index: number, useAlt: boolean) => void;
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

function FlagCard({
  flag, index, active, onLocate, onHover, onResolve,
}: {
  flag: Flag;
  index: number;
  active: boolean;
  onLocate: () => void;
  onHover: (i: number | null) => void;
  onResolve: (useAlt: boolean) => void;
}) {
  const disagree = flag.reason === 'disagree' && !!flag.alt;
  return (
    <li
      className={cx('flag-card', `flag-${flag.reason}`, active && 'is-active')}
      onMouseEnter={() => onHover(index)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(index)}
      onBlur={() => onHover(null)}
      data-testid="flag-chip"
    >
      <button className="flag-word" onClick={onLocate} title="نمایش این کلمه در متن و روی تصویر">
        {disagree ? (
          <>
            «<b>{flag.word}</b>» یا «<b>{flag.alt}</b>»؟
          </>
        ) : (
          <>
            «<b>{flag.word}</b>»
            <span className="flag-why">{flag.reason === 'low_conf' ? 'خوانا نبود' : 'دو خوانش متفاوت'}</span>
          </>
        )}
        <span className="flag-where">{fieldLabel(flag.field)}</span>
      </button>
      <div className="flag-actions">
        {disagree ? (
          <>
            <button className="btn btn-xs" onClick={() => onResolve(false)} data-testid="flag-keep" title="متن فعلی درست است">
              <Icon name="check" size={14} /> «{flag.word}» درست است
            </button>
            <button className="btn btn-xs btn-alt" onClick={() => onResolve(true)} data-testid="flag-use-alt" title="جایگزینی در متن">
              «{flag.alt}» بگذار
            </button>
          </>
        ) : (
          <button className="btn btn-xs" onClick={() => onResolve(false)} data-testid="flag-keep">
            <Icon name="check" size={14} /> درست است
          </button>
        )}
      </div>
    </li>
  );
}

export default function Editor(props: Props) {
  const {
    question: q, draft, saveState, activeFlagIndex, onChange, onOption, onBlurField, onSave, onApprove, onUnapprove,
    onReocr, onDelete, onAdd, onPrev, onNext, hasPrev, hasNext, onFlagClick, onFlagHover, onResolveFlag, onIssueClick,
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

        {flags.length > 0 && (
          <section className="flags-box" data-field="flags" tabIndex={-1} aria-labelledby={`${uid}-flags`}>
            <h3 id={`${uid}-flags`} className="flags-title">
              کلمات مشکوک ({fa(flags.length)})
              <span className="muted small"> — با تصویر مقایسه کنید و برای هر کدام یک گزینه را بزنید</span>
            </h3>
            <ul className="flag-list">
              {flags.map((f, i) => (
                <FlagCard
                  key={`${f.field}-${f.word}-${i}`}
                  flag={f}
                  index={i}
                  active={activeFlagIndex === i}
                  onLocate={() => onFlagClick(f, i)}
                  onHover={onFlagHover}
                  onResolve={(alt) => onResolveFlag(i, alt)}
                />
              ))}
            </ul>
          </section>
        )}
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
