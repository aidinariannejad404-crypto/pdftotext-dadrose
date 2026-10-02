import { useMemo } from 'react';
import { useAppData } from '../appData';
import type { Issue, Question } from '../types';
import { cx, fa, percent, questionState, type QState } from '../util';
import { Icon } from './Icons';

export type NavFilter = 'all' | 'problems' | 'pending';

const STATE_LABEL: Record<QState, string> = {
  approved: 'تأییدشده',
  error: 'دارای خطا',
  warning: 'نیازمند بررسی',
  neutral: 'تأییدنشده',
};

interface Props {
  questions: Question[];
  current: number | null;
  onSelect: (n: number) => void;
  filter: NavFilter;
  onFilter: (f: NavFilter) => void;
  projectIssues: Issue[];
  onAdd: () => void;
}

export default function Navigator({ questions, current, onSelect, filter, onFilter, projectIssues, onAdd }: Props) {
  const { meta, subjectName } = useAppData();
  const approved = questions.filter((q) => q.status === 'approved').length;
  const pct = percent(approved, questions.length);

  const visible = useMemo(
    () =>
      questions.filter((q) => {
        const s = questionState(q);
        if (filter === 'problems') return s === 'error' || s === 'warning';
        if (filter === 'pending') return s !== 'approved';
        return true;
      }),
    [questions, filter],
  );

  const groups = useMemo(() => {
    const order = new Map((meta?.subjects ?? []).map((s, i) => [s.key, i]));
    const map = new Map<string, Question[]>();
    for (const q of visible) {
      const k = q.subject_key ?? '';
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(q);
    }
    return [...map.entries()]
      .map(([key, qs]) => ({ key, qs: qs.sort((a, b) => a.number - b.number), first: Math.min(...qs.map((q) => q.number)) }))
      .sort((a, b) => {
        if (!a.key) return 1;
        if (!b.key) return -1;
        const oa = order.get(a.key) ?? 999;
        const ob = order.get(b.key) ?? 999;
        return oa - ob || a.first - b.first;
      });
  }, [visible, meta]);

  const counts = useMemo(() => {
    let problems = 0;
    let pending = 0;
    for (const q of questions) {
      const s = questionState(q);
      if (s === 'error' || s === 'warning') problems++;
      if (s !== 'approved') pending++;
    }
    return { all: questions.length, problems, pending };
  }, [questions]);

  return (
    <nav className="navigator" aria-label="فهرست سؤال‌ها">
      <div className="nav-progress">
        <div className="nav-progress-head">
          <span>تأییدشده</span>
          <span className="nav-progress-num">
            {fa(approved)} / {fa(questions.length)}
          </span>
        </div>
        <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="درصد تأییدشده">
          <div className="bar-fill bar-success" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {projectIssues.length > 0 && (
        <ul className="nav-issues" aria-label="مشکلات کلی پروژه">
          {projectIssues.map((i, idx) => (
            <li key={idx} className={`issue issue-${i.level}`}>
              <Icon name="alert" size={15} />
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="segmented" role="radiogroup" aria-label="فیلتر سؤال‌ها">
        {(
          [
            ['all', 'همه', counts.all],
            ['problems', 'مشکل‌دار', counts.problems],
            ['pending', 'تأییدنشده', counts.pending],
          ] as const
        ).map(([key, label, n]) => (
          <button
            key={key}
            role="radio"
            aria-checked={filter === key}
            className={cx('seg', filter === key && 'is-on')}
            onClick={() => onFilter(key)}
          >
            {label} <span className="seg-count">{fa(n)}</span>
          </button>
        ))}
      </div>

      <div className="nav-groups">
        {groups.length === 0 && <div className="muted small empty">سؤالی با این فیلتر نیست.</div>}
        {groups.map((g) => (
          <section key={g.key || '_none'} className="nav-group">
            <h3 className="nav-group-title">
              {subjectName(g.key || null)} <span className="muted">({fa(g.qs.length)})</span>
            </h3>
            <div className="qgrid">
              {g.qs.map((q) => {
                const s = questionState(q);
                return (
                  <button
                    key={q.number}
                    className={cx('qchip', `qchip-${s}`, q.number === current && 'is-current')}
                    onClick={() => onSelect(q.number)}
                    aria-current={q.number === current ? 'true' : undefined}
                    aria-label={`سؤال ${fa(q.number)} — ${STATE_LABEL[s]}`}
                    title={STATE_LABEL[s]}
                    data-testid={`qchip-${q.number}`}
                    data-state={s}
                  >
                    {fa(q.number)}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="nav-legend small muted" aria-hidden="true">
        <span><i className="dot dot-approved" /> تأییدشده</span>
        <span><i className="dot dot-error" /> خطا</span>
        <span><i className="dot dot-warning" /> نیاز به بررسی</span>
        <span><i className="dot dot-neutral" /> تأییدنشده</span>
      </div>

      <button className="btn btn-sm btn-ghost nav-add" onClick={onAdd}>
        <Icon name="plus" size={16} /> افزودن سؤال
      </button>
    </nav>
  );
}
