import { useMemo, useState } from 'react';
import { api } from '../api';
import type { Project } from '../types';
import { cx, fa, parseKeys, toAsciiDigits } from '../util';
import Modal from './Modal';
import { useToast } from './Toasts';

/** «ورود سریع کلید»: type the whole answer key at once, preview against current keys, PUT /keys. */
export default function KeysDialog({ project, onClose, onDone }: { project: Project; onClose: () => void; onDone: (p: Project) => void }) {
  const toast = useToast();
  const numbers = project.questions.map((q) => q.number).sort((a, b) => a - b);
  const firstMissing = project.questions.filter((q) => !q.correct_key).map((q) => q.number).sort((a, b) => a - b)[0];
  const [raw, setRaw] = useState('');
  const [start, setStart] = useState(String(numbers[0] ?? 1));
  const [busy, setBusy] = useState(false);
  const startNum = Number(toAsciiDigits(start)) || 1;
  const parsed = useMemo(() => parseKeys(raw), [raw]);
  const byNumber = new Map(project.questions.map((q) => [q.number, q]));

  const rows = parsed.map((k, i) => {
    const n = startNum + i;
    const q = byNumber.get(n);
    const cur = q?.correct_key ?? null;
    const state = !q ? 'missing' : !k ? 'skip' : !cur ? 'new' : cur === k ? 'same' : 'change';
    return { n, k, cur, state };
  });
  const changes = rows.filter((r) => r.state === 'change').length;
  const fills = rows.filter((r) => r.state === 'new').length;
  const absent = rows.filter((r) => r.state === 'missing' && r.k).length;
  // normalized: ASCII digits, 0 = skip (unambiguous for the backend)
  const normalized = parsed.map((k) => k ?? '0').join('');

  const save = async () => {
    setBusy(true);
    try {
      const p = await api.putKeys(project.id, normalized, startNum);
      toast.success(`کلید ${fa(fills + changes)} سؤال ثبت شد.`);
      onDone(p);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="ورود سریع کلید"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-primary" onClick={save} disabled={busy || fills + changes === 0} data-testid="keys-save">
            {busy ? 'در حال ثبت…' : `ثبت کلید ${fa(fills + changes)} سؤال`}
          </button>
          <button className="btn" onClick={onClose}>
            انصراف
          </button>
        </>
      }
    >
      <p className="small">
        کلید سؤال‌ها را پشت سر هم تایپ کنید، مثلاً «۲۴۱۳۳۱». برای رد شدن از یک سؤال <b>۰</b>، <b>-</b> یا فاصله بگذارید. «الف ب ج د»
        هم با فاصله قبول است.
      </p>
      <div className="keys-inputs">
        <label className="field keys-start">
          <span className="field-label">از سؤال شماره‌ی</span>
          <input className="input input-sm" value={start} onChange={(e) => setStart(e.target.value)} inputMode="numeric" dir="ltr" data-testid="keys-start" />
          {firstMissing !== undefined && firstMissing !== startNum && (
            <button className="link small" onClick={() => setStart(String(firstMissing))}>
              اولین سؤال بدون کلید: {fa(firstMissing)}
            </button>
          )}
        </label>
        <label className="field keys-raw">
          <span className="field-label">کلیدها</span>
          <textarea
            className="input keys-text"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={2}
            dir="ltr"
            spellCheck={false}
            placeholder="2413 3142 …"
            data-autofocus
            data-testid="keys-input"
          />
        </label>
      </div>
      {rows.length > 0 && (
        <>
          <div className="small keys-summary">
            {fa(rows.length)} کلید خوانده شد · <span className="text-success">{fa(fills)} جدید</span> ·{' '}
            <span className={changes ? 'text-danger' : undefined}>{fa(changes)} تغییر</span>
            {absent > 0 && <span className="muted"> · {fa(absent)} شماره در پروژه نیست</span>}
          </div>
          <ol className="keys-grid" data-testid="keys-grid">
            {rows.map((r) => (
              <li key={r.n} className={cx('keys-cell', `keys-${r.state}`)} title={r.state === 'change' ? `کلید فعلی ${fa(r.cur ?? '')} → ${fa(r.k ?? '')}` : undefined}>
                <span className="keys-n">{fa(r.n)}</span>
                <span className="keys-k">{r.k ? fa(r.k) : '—'}</span>
                {r.state === 'change' && <span className="keys-old">{fa(r.cur ?? '')}</span>}
              </li>
            ))}
          </ol>
        </>
      )}
    </Modal>
  );
}
