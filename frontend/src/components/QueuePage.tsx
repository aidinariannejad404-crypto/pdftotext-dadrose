import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { ReviewQueueItem } from '../types';
import { ISSUE_CODE_LABELS, cx, fa } from '../util';
import { navigate } from '../App';
import { BrandMark, Icon } from './Icons';

type Level = 'all' | 'error' | 'warning' | 'pending';

const LEVEL_LABEL: Record<ReviewQueueItem['level'], string> = {
  error: 'خطا',
  warning: 'نیاز به بررسی',
  pending: 'تأییدنشده',
};

export function queueHref(it: Pick<ReviewQueueItem, 'project_id' | 'number'>) {
  return `#/p/${encodeURIComponent(it.project_id)}?q=${it.number}&from=queue`;
}

/** All questions needing attention across projects, errors first (GET /api/review-queue). */
export default function QueuePage() {
  const [items, setItems] = useState<ReviewQueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState('');
  const [level, setLevel] = useState<Level>('all');

  const load = useCallback(async () => {
    try {
      setItems(await api.reviewQueue());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    document.title = 'دادرس — صف بازبینی';
  }, [load]);

  const projects = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items ?? []) m.set(it.project_id, it.project_title);
    return [...m.entries()];
  }, [items]);

  const visible = (items ?? []).filter((it) => (!project || it.project_id === project) && (level === 'all' || it.level === level));
  const count = (l: ReviewQueueItem['level']) => (items ?? []).filter((it) => (!project || it.project_id === project) && it.level === l).length;

  return (
    <div className="page">
      <header className="topbar">
        <a href="#/" className="brand" aria-label="بازگشت به فهرست پروژه‌ها">
          <BrandMark />
          <div>
            <div className="brand-name">دادرس</div>
            <div className="brand-sub">صف بازبینی همه‌ی پروژه‌ها</div>
          </div>
        </a>
        <span className="spacer" />
        <a className="btn btn-sm btn-ghost topbar-btn" href="#/">
          <Icon name="back" size={16} /> پروژه‌ها
        </a>
      </header>
      <main className="container">
        <section className="card" aria-labelledby="queue-title">
          <div className="card-head">
            <h2 id="queue-title" className="card-title">
              صف بازبینی
            </h2>
            {items && <span className="muted small">{fa(items.length)} سؤال نیاز به رسیدگی دارد — خطاها اول</span>}
            <span className="spacer" />
            {visible.length > 0 && (
              <button className="btn btn-sm btn-primary" onClick={() => navigate(queueHref(visible[0]))} data-testid="queue-start">
                شروع از اولین مورد
              </button>
            )}
          </div>
          <div className="queue-filters">
            <select className="input input-sm" value={project} onChange={(e) => setProject(e.target.value)} aria-label="پروژه" data-testid="queue-project">
              <option value="">همه‌ی پروژه‌ها</option>
              {projects.map(([id, title]) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </select>
            <div className="segmented segmented-sm" role="radiogroup" aria-label="سطح">
              {(
                [
                  ['all', 'همه', (items ?? []).filter((it) => !project || it.project_id === project).length],
                  ['error', 'خطا', count('error')],
                  ['warning', 'نیاز به بررسی', count('warning')],
                  ['pending', 'تأییدنشده', count('pending')],
                ] as [Level, string, number][]
              ).map(([k, label, n]) => (
                <button key={k} role="radio" aria-checked={level === k} className={cx('seg', level === k && 'is-on')} onClick={() => setLevel(k)} data-testid={`queue-level-${k}`}>
                  {label} <span className="seg-count">{fa(n)}</span>
                </button>
              ))}
            </div>
            <button className="btn btn-sm btn-ghost" onClick={load} title="به‌روزرسانی">
              <Icon name="refresh" size={16} /> به‌روزرسانی
            </button>
          </div>
          {error && <div className="alert alert-danger">{error}</div>}
          {!items && !error && <div className="empty muted">در حال بارگذاری…</div>}
          {items && visible.length === 0 && (
            <div className="empty-state">
              <Icon name="check" size={40} className="empty-icon" />
              <div className="empty-title">صف خالی است</div>
              <div className="muted">سؤالی برای رسیدگی نمانده است.</div>
            </div>
          )}
          {visible.length > 0 && (
            <ol className="queue-list">
              {visible.map((it) => (
                <li key={`${it.project_id}-${it.number}`}>
                  <a className={cx('queue-item', `queue-${it.level}`)} href={queueHref(it)} data-testid="queue-item">
                    <span className={cx('chip', it.level === 'error' ? 'chip-failed' : it.level === 'warning' ? 'chip-warning' : 'chip-queued')}>
                      {LEVEL_LABEL[it.level]}
                    </span>
                    <span className="queue-q">سؤال {fa(it.number)}</span>
                    <span className="queue-project muted">{it.project_title}</span>
                    <span className="queue-codes small">
                      {it.codes.map((c) => ISSUE_CODE_LABELS[c] ?? c).join('، ')}
                      {it.flags > 0 && ` · ${fa(it.flags)} کلمه‌ی مشکوک`}
                    </span>
                    <Icon name="chev-left" size={16} />
                  </a>
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
    </div>
  );
}
