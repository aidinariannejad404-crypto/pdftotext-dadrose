import { useId, useState } from 'react';
import { useAppData } from '../appData';
import type { ArticleRef, ClassSource, Classification, Law } from '../types';
import type { Draft } from '../useDraft';
import { CLASS_SOURCE_LABELS, articleLabel, cx, toAsciiDigits } from '../util';
import { Icon } from './Icons';

export function SourceBadge({ source, confidence }: { source?: ClassSource | null; confidence?: number | null }) {
  if (!source) return null;
  const low = confidence !== null && confidence !== undefined && confidence < 0.6;
  return (
    <span
      className={cx('src-badge', `src-${source}`, low && 'is-low')}
      title={`منبع: ${CLASS_SOURCE_LABELS[source] ?? source}${low ? ' — اطمینان پایین، بررسی کنید' : ''}`}
      data-testid="src-badge"
    >
      {CLASS_SOURCE_LABELS[source] ?? source}
      {low && <b aria-label="اطمینان پایین">؟</b>}
    </span>
  );
}

const emptyArticle = (law?: Law): ArticleRef => ({
  law_key: law?.key ?? null,
  law: law?.name ?? '',
  kind: law && /اساسی/.test(law.name) ? 'اصل' : 'ماده',
  number: '',
  clause: '',
  source: 'manual',
  field: null,
});

function ArticleForm({
  initial, laws, onSave, onCancel,
}: {
  initial: ArticleRef;
  laws: Law[];
  onSave: (a: ArticleRef) => void;
  onCancel: () => void;
}) {
  const [a, setA] = useState<ArticleRef>(initial);
  const uid = useId();
  const valid = toAsciiDigits(a.number).trim() !== '' && (a.law_key || a.law.trim());
  const pickLaw = (key: string) => {
    const law = laws.find((l) => l.key === key);
    if (key === '__other') setA({ ...a, law_key: null, law: '' });
    else if (law) setA({ ...a, law_key: law.key, law: law.name, kind: /اساسی/.test(law.name) ? 'اصل' : a.kind });
  };
  return (
    <form
      className="article-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave({ ...a, number: a.number.trim(), clause: a.clause.trim(), source: 'manual' });
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
      data-testid="article-form"
    >
      <label className="visually-hidden" htmlFor={`${uid}-law`}>
        قانون
      </label>
      <select id={`${uid}-law`} className="input input-sm af-law" value={a.law_key ?? (a.law ? '__other' : '')} onChange={(e) => pickLaw(e.target.value)} data-testid="article-law">
        <option value="" disabled>
          — قانون —
        </option>
        {laws.map((l) => (
          <option key={l.key} value={l.key}>
            {l.name}
          </option>
        ))}
        <option value="__other">سایر (نام دلخواه)…</option>
      </select>
      {!a.law_key && (
        <input className="input input-sm af-name" value={a.law} onChange={(e) => setA({ ...a, law: e.target.value })} placeholder="نام قانون" aria-label="نام قانون" />
      )}
      <select className="input input-sm af-kind" value={a.kind} onChange={(e) => setA({ ...a, kind: e.target.value as ArticleRef['kind'] })} aria-label="نوع">
        <option value="ماده">ماده</option>
        <option value="اصل">اصل</option>
      </select>
      <input
        className="input input-sm af-num"
        value={a.number}
        onChange={(e) => setA({ ...a, number: e.target.value })}
        placeholder="شماره"
        aria-label="شماره‌ی ماده"
        autoFocus
        data-testid="article-number"
      />
      <input className="input input-sm af-clause" value={a.clause} onChange={(e) => setA({ ...a, clause: e.target.value })} placeholder="بند / تبصره" aria-label="بند یا تبصره" />
      <button type="submit" className="btn btn-xs btn-primary" disabled={!valid} data-testid="article-save">
        ثبت
      </button>
      <button type="button" className="btn btn-xs btn-ghost" onClick={onCancel}>
        انصراف
      </button>
    </form>
  );
}

interface Props {
  draft: Draft;
  classification?: Classification;
  onChange: (patch: Partial<Draft>, immediate?: boolean) => void;
  onBlur: () => void;
  subjectInvalid: boolean;
}

/** درس / مبحث / مواد قانونی for one question. */
export default function ClassificationSection({ draft, classification: c, onChange, onBlur, subjectInvalid }: Props) {
  const { meta } = useAppData();
  const uid = useId();
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const subjects = meta?.subjects ?? [];
  const knownSubject = !draft.subject_key || subjects.some((s) => s.key === draft.subject_key);
  const suggestions = (draft.subject_key && meta?.topics?.[draft.subject_key]) || [];
  const allLaws = meta?.laws ?? [];
  // laws of this subject first
  const laws = [...allLaws.filter((l) => l.subject_key === draft.subject_key), ...allLaws.filter((l) => l.subject_key !== draft.subject_key)];
  const defaultLaw = allLaws.find((l) => l.subject_key === draft.subject_key);

  const saveArticle = (a: ArticleRef) => {
    const list = [...draft.articles];
    if (editing === 'new') list.push(a);
    else if (typeof editing === 'number') list[editing] = a;
    setEditing(null);
    onChange({ articles: list }, true);
  };
  const removeArticle = (i: number) => onChange({ articles: draft.articles.filter((_, k) => k !== i) }, true);

  return (
    <section className="classify" aria-label="طبقه‌بندی">
      {c?.section_path && c.section_path.length > 0 && (
        <div className="section-path small muted" title="سرفصل‌های کتاب بالای این سؤال">
          {c.section_path.join(' › ')}
        </div>
      )}
      <div className="classify-row">
        <label className="classify-field">
          <span className="field-label">
            درس <SourceBadge source={c?.subject_source} confidence={c?.subject_confidence} />
          </span>
          <select
            id={`${uid}-subject`}
            data-field="subject"
            className={cx('input input-sm', !draft.subject_key && 'is-warning', subjectInvalid && 'is-invalid')}
            value={draft.subject_key ?? ''}
            onChange={(e) => onChange({ subject_key: e.target.value || null }, true)}
          >
            <option value="">— درس را انتخاب کنید —</option>
            {!knownSubject && <option value={draft.subject_key!}>{draft.subject_key}</option>}
            {subjects.map((x) => (
              <option key={x.key} value={x.key}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="classify-field classify-topic">
          <span className="field-label">
            مبحث <SourceBadge source={c?.topic_source} confidence={c?.topic_confidence} />
          </span>
          <input
            className="input input-sm"
            list={`${uid}-topics`}
            value={draft.topic}
            onChange={(e) => onChange({ topic: e.target.value })}
            onBlur={onBlur}
            placeholder={suggestions.length ? 'انتخاب یا تایپ مبحث' : 'مبحث (اختیاری)'}
            data-field="topic"
          />
          <datalist id={`${uid}-topics`}>
            {suggestions.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
      </div>
      <div className="articles" aria-label="مواد قانونی">
        <span className="field-label">مواد قانونی</span>
        {draft.articles.map((a, i) =>
          editing === i ? (
            <ArticleForm key={i} initial={a} laws={laws} onSave={saveArticle} onCancel={() => setEditing(null)} />
          ) : (
            <span key={i} className={cx('article-chip', `src-${a.source}`)} data-testid="article-chip">
              <button className="article-text" onClick={() => setEditing(i)} title="ویرایش">
                {articleLabel(a)}
              </button>
              <SourceBadge source={a.source} />
              <button className="article-x" onClick={() => removeArticle(i)} aria-label={`حذف ${articleLabel(a)}`} title="حذف">
                ×
              </button>
            </span>
          ),
        )}
        {editing === 'new' ? (
          <ArticleForm initial={emptyArticle(defaultLaw)} laws={laws} onSave={saveArticle} onCancel={() => setEditing(null)} />
        ) : (
          <button className="btn btn-xs btn-ghost" onClick={() => setEditing('new')} data-testid="article-add">
            <Icon name="plus" size={14} /> افزودن ماده
          </button>
        )}
      </div>
    </section>
  );
}
