import { useMemo, useState } from 'react';
import { useAppData } from '../appData';
import type { Issue, Question } from '../types';
import { articleLabel, cx, fa, percent, questionState, searchable, type QState } from '../util';
import { Icon } from './Icons';

export type NavFilter = 'all' | 'problems' | 'pending';
export type GroupBy = 'subject' | 'topic' | 'article';

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
  missingKeys?: number;
  onKeys?: () => void;
}

export default function Navigator({ questions, current, onSelect, filter, onFilter, projectIssues, onAdd, missingKeys = 0, onKeys }: Props) {
  const { meta, subjectName } = useAppData();
  const approved = questions.filter((q) => q.status === 'approved').length;
  const pct = percent(approved, questions.length);

  const [groupBy, setGroupBy] = useState<GroupBy>('subject');
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const qn = searchable(query.trim());
    return questions.filter((q) => {
      const s = questionState(q);
      if (filter === 'problems' && s !== 'error' && s !== 'warning') return false;
      if (filter === 'pending' && s === 'approved') return false;
      if (!qn) return true;
      if (/^\d+$/.test(qn)) {
        // a bare number: question number or article number
        if (String(q.number) === qn) return true;
        if ((q.articles ?? []).some((a) => searchable(a.number).split(/\s/)[0] === qn)) return true;
      }
      const hay = searchable(
        [q.stem, q.topic ?? '', ...q.options.map((o) => o.text), ...(q.articles ?? []).map((a) => `${a.kind} ${a.number} ${a.law}`)].join(' '),
      );
      return hay.includes(qn);
    });
  }, [questions, filter, query]);

  const groups = useMemo(() => {
    const byNumber = (a: Question, b: Question) => a.number - b.number;
    if (groupBy === 'topic') {
      const map = new Map<string, Question[]>();
      for (const q of visible) {
        const k = (q.topic ?? '').trim();
        if (!map.has(k)) map.set(k, []);
        map.get(k)!.push(q);
      }
      return [...map.entries()]
        .map(([key, qs]) => ({ key, title: key || 'بدون مبحث', qs: qs.sort(byNumber), first: Math.min(...qs.map((q) => q.number)) }))
        .sort((a, b) => (!a.key ? 1 : !b.key ? -1 : a.first - b.first));
    }
    if (groupBy === 'article') {
      const map = new Map<string, { title: string; law: string; num: number; qs: Question[] }>();
      for (const q of visible) {
        const arts = q.articles ?? [];
        if (!arts.length) {
          if (!map.has('')) map.set('', { title: 'بدون ماده', law: '\uffff', num: 0, qs: [] });
          map.get('')!.qs.push(q);
        }
        for (const a of arts) {
          const key = `${a.law_key ?? a.law}|${a.kind}|${searchable(a.number)}`;
          if (!map.has(key)) {
            map.set(key, { title: articleLabel({ ...a, clause: '' }), law: a.law, num: parseInt(searchable(a.number), 10) || 0, qs: [] });
          }
          const g = map.get(key)!;
          if (!g.qs.includes(q)) g.qs.push(q);
        }
      }
      return [...map.entries()]
        .map(([key, g]) => ({ key, title: g.title, qs: g.qs.sort(byNumber), law: g.law, num: g.num, first: 0 }))
        .sort((a, b) => a.law.localeCompare(b.law, 'fa') || a.num - b.num);
    }
    const order = new Map((meta?.subjects ?? []).map((s, i) => [s.key, i]));
    const map = new Map<string, Question[]>();
    for (const q of visible) {
      const k = q.subject_key ?? '';
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(q);
    }
    return [...map.entries()]
      .map(([key, qs]) => ({ key, title: subjectName(key || null), qs: qs.sort(byNumber), first: Math.min(...qs.map((q) => q.number)) }))
      .sort((a, b) => {
        if (!a.key) return 1;
        if (!b.key) return -1;
        const oa = order.get(a.key) ?? 999;
        const ob = order.get(b.key) ?? 999;
        return oa - ob || a.first - b.first;
      });
  }, [visible, meta, groupBy, subjectName]);

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

      {missingKeys >= 3 && onKeys && (
        <div className="keys-hint small" data-testid="keys-hint">
          {fa(missingKeys)} سؤال کلید ندارند.{' '}
          <button className="link" onClick={onKeys}>
            ورود سریع کلید
          </button>
        </div>
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

      <div className="nav-tools">
        <input
          type="search"
          className="input input-sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="جست‌وجو: متن، مبحث، شماره‌ی ماده…"
          aria-label="جست‌وجو در سؤال‌ها"
          data-testid="nav-search"
        />
        <div className="segmented segmented-sm" role="radiogroup" aria-label="گروه‌بندی بر اساس">
          {(
            [
              ['subject', 'درس'],
              ['topic', 'مبحث'],
              ['article', 'ماده'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              role="radio"
              aria-checked={groupBy === k}
              className={cx('seg', groupBy === k && 'is-on')}
              onClick={() => setGroupBy(k)}
              data-testid={`group-${k}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="nav-groups">
        {groups.length === 0 && <div className="muted small empty">سؤالی با این فیلتر یا جست‌وجو نیست.</div>}
        {groups.map((g) => (
          <section key={g.key || '_none'} className="nav-group" data-testid="nav-group">
            <h3 className="nav-group-title">
              {g.title} <span className="muted">({fa(g.qs.length)})</span>
            </h3>
            <div className="qgrid">
              {g.qs.map((q) => {
                const s = questionState(q);
                return (
                  <button
                    key={q.number}
                    className={cx('qchip', `qchip-${s}`, q.number === current && 'is-current', q.status === 'approved' && q.approved_by === 'auto' && 'is-auto', (q.duplicates ?? []).length > 0 && 'is-dup')}
                    onClick={() => onSelect(q.number)}
                    aria-current={q.number === current ? 'true' : undefined}
                    aria-label={`سؤال ${fa(q.number)} — ${STATE_LABEL[s]}${q.approved_by === 'auto' && s === 'approved' ? ' (خودکار)' : ''}`}
                    title={`${STATE_LABEL[s]}${q.approved_by === 'auto' && s === 'approved' ? ' (خودکار)' : ''}${(q.duplicates ?? []).length ? ' · تکراری' : ''}`}
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
