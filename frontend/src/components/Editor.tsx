import { useId } from 'react';
import { useAppData } from '../appData';
import type { Flag, Question } from '../types';
import type { Draft, SaveState } from '../useDraft';
import { KEY_SOURCE_LABELS, cx, fa, fieldLabel, type MarkRange } from '../util';
import HighlightField from './HighlightField';
import { Icon } from './Icons';

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
  register: (field: string, el: HTMLTextAreaElement | null) => void;
  index: number;
  total: number;
  reocrBusy: boolean;
  hasExplanations: boolean;
}

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'ذخیره شد',
  dirty: 'تغییرات ذخیره‌نشده',
  saving: 'در حال ذخیره…',
  error: 'خطا در ذخیره',
};

export function SaveIndicator({ state }: { state: SaveState }) {
  return (
    <span className={`save-state save-${state}`} role="status" aria-live="polite" data-testid="save-state">
      <i className="save-dot" aria-hidden="true" />
      {SAVE_LABEL[state]}
    </span>
  );
}

export default function Editor(props: Props) {
  const {
    question: q, draft, saveState, activeFlagIndex, onChange, onOption, onBlurField, onSave, onApprove, onUnapprove,
    onReocr, onDelete, onAdd, onPrev, onNext, hasPrev, hasNext, onFlagClick, register, index, total, reocrBusy,
    hasExplanations,
  } = props;
  const { meta } = useAppData();
  const uid = useId();
  const approved = q.status === 'approved';
  const fieldIssues = (field: string) => q.issues.filter((i) => i.field === field);
  const fieldHasError = (field: string) => fieldIssues(field).some((i) => i.level === 'error');
  const errors = q.issues.filter((i) => i.level === 'error');
  const warnings = q.issues.filter((i) => i.level === 'warning');

  const markClick = (m: MarkRange) => onFlagClick(m.flag, m.flagIndex);
  const subjects = meta?.subjects ?? [];
  const knownSubject = !draft.subject_key || subjects.some((s) => s.key === draft.subject_key);

  return (
    <section className="editor" aria-label={`ویرایش سؤال ${fa(q.number)}`}>
      <div className="editor-head">
        <div className="editor-title">
          <h2 className="qnum">
            سؤال <span data-testid="current-number">{fa(q.number)}</span>
          </h2>
          <span className="muted small">
            {fa(index + 1)} از {fa(total)}
          </span>
          {approved && (
            <span className="chip chip-approved">
              <Icon name="check" size={14} /> تأییدشده
            </span>
          )}
          {q.edited && !approved && <span className="chip chip-neutral">ویرایش‌شده</span>}
        </div>
        <div className="editor-head-tools">
          <label className="subject-select">
            <span className="visually-hidden">درس</span>
            <select
              className={cx('input input-sm', !draft.subject_key && 'is-warning')}
              value={draft.subject_key ?? ''}
              onChange={(e) => onChange({ subject_key: e.target.value || null }, true)}
              aria-label="درس"
            >
              <option value="">— درس نامشخص —</option>
              {!knownSubject && <option value={draft.subject_key!}>{draft.subject_key}</option>}
              {subjects.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <SaveIndicator state={saveState} />
          <div className="btn-group" role="group" aria-label="جابه‌جایی بین سؤال‌ها">
            <button className="btn btn-sm btn-icon" onClick={onPrev} disabled={!hasPrev} title="قبلی (Alt+↑)" aria-label="سؤال قبلی">
              <Icon name="chev-right" />
            </button>
            <button className="btn btn-sm btn-icon" onClick={onNext} disabled={!hasNext} title="بعدی (Alt+↓)" aria-label="سؤال بعدی">
              <Icon name="chev-left" />
            </button>
          </div>
        </div>
      </div>

      <div className="editor-scroll">
        {(q.issues.length > 0 || q.flags.length > 0) && (
          <div className="notes">
            {q.issues.length > 0 && (
              <ul className="issues" aria-label="مشکلات سؤال">
                {[...errors, ...warnings].map((i, idx) => (
                  <li key={idx} className={`issue issue-${i.level}`}>
                    <Icon name="alert" size={15} />
                    <span>{i.message}</span>
                    {i.field && <span className="issue-field">{fieldLabel(i.field)}</span>}
                  </li>
                ))}
              </ul>
            )}
            {q.flags.length > 0 && (
              <div className="flags">
                <span className="flags-label small muted">کلمات مشکوک:</span>
                {q.flags.map((f, i) => (
                  <button
                    key={i}
                    className={cx('flag-chip', `flag-${f.reason}`, activeFlagIndex === i && 'is-active')}
                    onClick={() => onFlagClick(f, i)}
                    title={
                      f.reason === 'disagree'
                        ? `اختلاف دو موتور — خوانش دیگر: ${f.alt ?? '—'} (${fieldLabel(f.field)})`
                        : `اطمینان پایین (${fieldLabel(f.field)})`
                    }
                    data-testid="flag-chip"
                  >
                    <span dir="auto">{f.word}</span>
                    {f.reason === 'disagree' && f.alt && (
                      <span className="flag-alt" dir="auto">
                        ← {f.alt}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="field-block">
          <label className="field-label" htmlFor={`${uid}-stem`}>
            صورت سؤال
          </label>
          <HighlightField
            id={`${uid}-stem`}
            field="stem"
            label="صورت سؤال"
            value={draft.stem}
            flags={q.flags}
            onChange={(v) => onChange({ stem: v })}
            onBlur={onBlurField}
            register={register}
            activeFlagIndex={activeFlagIndex}
            invalid={fieldHasError('stem')}
            onMarkClick={markClick}
            placeholder="متن سؤال…"
          />
        </div>

        <fieldset className="options">
          <legend className="field-label">
            گزینه‌ها و کلید
            <span className={cx('key-source', !draft.correct_key && 'is-missing')}>
              {draft.correct_key
                ? `کلید: گزینه‌ی ${fa(draft.correct_key)}${q.key_source ? ` — ${KEY_SOURCE_LABELS[q.key_source]}` : ''}`
                : 'کلید تعیین نشده'}
            </span>
          </legend>
          {draft.options.map((o) => {
            const field = `option:${o.key}`;
            const isKey = draft.correct_key === o.key;
            return (
              <div key={o.key} className={cx('option-row', isKey && 'is-key')} data-testid={`option-${o.key}`}>
                <label className="option-key" title="انتخاب به‌عنوان پاسخ درست">
                  <input
                    type="radio"
                    name={`${uid}-key`}
                    checked={isKey}
                    onChange={() => onChange({ correct_key: o.key }, true)}
                    aria-label={`گزینه‌ی ${fa(o.key)} پاسخ درست است`}
                  />
                  <span className="option-num">{fa(o.key)}</span>
                </label>
                <HighlightField
                  id={`${uid}-${field}`}
                  field={field}
                  label={`متن گزینه‌ی ${fa(o.key)}`}
                  value={o.text}
                  flags={q.flags}
                  onChange={(v) => onOption(o.key, v)}
                  onBlur={onBlurField}
                  register={register}
                  activeFlagIndex={activeFlagIndex}
                  invalid={fieldHasError(field)}
                  compact
                  onMarkClick={markClick}
                  placeholder={`گزینه‌ی ${fa(o.key)}`}
                />
              </div>
            );
          })}
        </fieldset>

        <div className="field-block">
          <label className="field-label" htmlFor={`${uid}-explanation`}>
            پاسخ تشریحی {!hasExplanations && <span className="muted small">(فایل پاسخ تشریحی بارگذاری نشده)</span>}
          </label>
          <HighlightField
            id={`${uid}-explanation`}
            field="explanation"
            label="پاسخ تشریحی"
            value={draft.explanation}
            flags={q.flags}
            onChange={(v) => onChange({ explanation: v })}
            onBlur={onBlurField}
            register={register}
            activeFlagIndex={activeFlagIndex}
            invalid={fieldHasError('explanation')}
            onMarkClick={markClick}
            placeholder="توضیح پاسخ…"
          />
        </div>
      </div>

      <div className="editor-actions">
        {approved ? (
          <>
            <button className="btn btn-success" onClick={onApprove} title="Ctrl+Enter" data-testid="approve">
              <Icon name="check" /> بعدی
            </button>
            <button className="btn btn-sm btn-ghost" onClick={onUnapprove}>
              لغو تأیید
            </button>
          </>
        ) : (
          <button className="btn btn-success" onClick={onApprove} title="Ctrl+Enter" data-testid="approve">
            <Icon name="check" /> تأیید و بعدی <kbd>Ctrl+↵</kbd>
          </button>
        )}
        <button className="btn" onClick={onSave} disabled={saveState === 'saved' || saveState === 'saving'}>
          <Icon name="save" /> ذخیره
        </button>
        <button className="btn" onClick={onReocr} disabled={reocrBusy || q.regions.length === 0} title={q.regions.length === 0 ? 'این سؤال ناحیه‌ای روی صفحه ندارد' : undefined}>
          <Icon name="sparkle" /> {reocrBusy ? 'در حال بازخوانی…' : 'بازخوانی با هوش مصنوعی'}
        </button>
        <span className="spacer" />
        <button className="btn btn-sm btn-ghost" onClick={onAdd}>
          <Icon name="plus" size={16} /> افزودن
        </button>
        <button className="btn btn-sm btn-ghost btn-danger-text" onClick={onDelete}>
          <Icon name="trash" size={16} /> حذف سؤال
        </button>
      </div>
    </section>
  );
}
