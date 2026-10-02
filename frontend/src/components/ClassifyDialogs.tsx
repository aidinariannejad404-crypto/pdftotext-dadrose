import { useEffect, useMemo, useState } from 'react';
import { loadPage } from '../pageCache';
import { api } from '../api';
import { useAppData } from '../appData';
import type { AiMode, ClassifyEngine, Project, Question } from '../types';
import { aiUsageText, articleLabel, cx, fa, faNum } from '../util';
import Modal from './Modal';
import { useToast } from './Toasts';

export function ClassifyDialog({
  project, onClose, onDone,
}: {
  project: Project;
  onClose: () => void;
  onDone: (p: Project) => void;
}) {
  const { engineAvailable } = useAppData();
  const toast = useToast();
  const aiOk = engineAvailable('claude') || engineAvailable('gemini');
  const [engine, setEngine] = useState<ClassifyEngine>('rules');
  const [scope, setScope] = useState<'all' | 'missing'>('all');
  const [busy, setBusy] = useState(false);
  const missing = project.questions.filter((q) => !(q.topic ?? '').trim()).map((q) => q.number);
  const target = scope === 'all' ? project.questions.length : missing.length;

  const run = async () => {
    setBusy(true);
    const before = new Map(project.questions.map((q) => [q.number, q]));
    try {
      const p = await api.classify(project.id, engine, scope === 'missing' ? missing : undefined);
      let topics = 0;
      let articles = 0;
      for (const q of p.questions) {
        const old = before.get(q.number);
        if ((q.topic ?? '') && (q.topic ?? '') !== (old?.topic ?? '')) topics++;
        if ((q.articles ?? []).length > (old?.articles ?? []).length) articles++;
      }
      const withTopic = p.questions.filter((q) => (q.topic ?? '').trim()).length;
      toast.success(
        `طبقه‌بندی انجام شد: مبحث ${fa(topics)} سؤال و مواد قانونی ${fa(articles)} سؤال به‌روز شد (${fa(withTopic)} از ${fa(p.questions.length)} سؤال مبحث دارند).`,
      );
      onDone(p);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const engines: [ClassifyEngine, string, boolean, string][] = [
    ['rules', 'فقط قواعد (رایگان)', true, 'سرفصل‌ها، الگوی آزمون و کلیدواژه‌ها؛ بدون هوش مصنوعی'],
    ['auto', 'هوشمند: هوش مصنوعی فقط برای سؤال‌های نامطمئن', aiOk, 'اول قواعد؛ سؤال‌هایی که با اطمینان تشخیص داده نشدند به هوش مصنوعی فرستاده می‌شوند'],
  ];

  return (
    <Modal
      title="طبقه‌بندی خودکار سؤال‌ها"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-primary" onClick={run} disabled={busy || target === 0} data-testid="confirm-classify">
            {busy ? 'در حال طبقه‌بندی…' : `طبقه‌بندی ${fa(target)} سؤال`}
          </button>
          <button className="btn" onClick={onClose}>
            انصراف
          </button>
        </>
      }
    >
      <p className="muted small">
        درس، مبحث و مواد قانونی هر سؤال تشخیص داده می‌شود. <b>مواردی که خودتان ویرایش کرده‌اید دست نمی‌خورند.</b>
      </p>
      <fieldset className="radio-list">
        <legend className="field-label">روش</legend>
        {engines.map(([v, label, ok, hint]) => (
          <label key={v} className={cx('radio-row', !ok && 'is-disabled')}>
            <input type="radio" name="cls-engine" checked={engine === v} disabled={!ok} onChange={() => setEngine(v)} />
            <span>
              {label}
              <span className="muted small"> — {ok ? hint : 'پیکربندی نشده'}</span>
            </span>
          </label>
        ))}
        {!aiOk && <span className="field-hint">برای هوش مصنوعی، کلید API در تنظیمات سرور لازم است.</span>}
      </fieldset>
      <fieldset className="radio-list">
        <legend className="field-label">کدام سؤال‌ها</legend>
        <label className="radio-row">
          <input type="radio" name="cls-scope" checked={scope === 'all'} onChange={() => setScope('all')} />
          <span>همه‌ی سؤال‌ها ({fa(project.questions.length)})</span>
        </label>
        <label className="radio-row">
          <input type="radio" name="cls-scope" checked={scope === 'missing'} onChange={() => setScope('missing')} data-testid="scope-missing" />
          <span>فقط سؤال‌های بدون مبحث ({fa(missing.length)})</span>
        </label>
      </fieldset>
    </Modal>
  );
}

function top<T>(entries: [T, number][], n: number) {
  return entries.sort((a, b) => b[1] - a[1]).slice(0, n);
}

function AiUsageSection({ project }: { project: Project }) {
  const [modes, setModes] = useState<Record<AiMode, number> | null>(null);
  useEffect(() => {
    let alive = true;
    const jobs = project.documents.flatMap((d) => Array.from({ length: d.page_count }, (_, i) => loadPage(project.id, d.kind, i).catch(() => null)));
    void Promise.all(jobs).then((pages) => {
      if (!alive) return;
      const m: Record<AiMode, number> = { none: 0, correct: 0, transcribe: 0 };
      for (const p of pages) if (p) m[p.ai_mode ?? 'none']++;
      setModes(m);
    });
    return () => {
      alive = false;
    };
  }, [project]);
  const u = project.stats?.ai_usage;
  return (
    <section data-testid="ai-stats">
      <h3>مصرف هوش مصنوعی</h3>
      <ul className="ai-modes">
        {(['none', 'correct', 'transcribe'] as AiMode[]).map((m) => (
          <li key={m}>
            <span className={`mode-dot mode-${m}`} />
            {m === 'none' ? 'بدون نیاز (آفلاین)' : m === 'correct' ? 'اصلاح خطوط مشکوک' : 'بازنویسی کامل'}:{' '}
            <b>{modes ? fa(modes[m]) : '…'}</b> صفحه
          </li>
        ))}
      </ul>
      {u && (u.calls > 0 || u.cached > 0) ? (
        <table className="ai-table">
          <tbody>
            <tr><td>درخواست‌ها</td><td>{faNum(u.calls)}</td></tr>
            <tr><td>توکن ورودی</td><td>{faNum(u.input_tokens)}</td></tr>
            <tr><td>توکن خروجی</td><td>{faNum(u.output_tokens)}</td></tr>
            <tr><td>پاسخ از حافظه (رایگان)</td><td>{faNum(u.cached)}</td></tr>
            <tr><td>هزینه‌ی تقریبی</td><td>{project.stats?.ai_cost_usd ? `≈ ${new Intl.NumberFormat('fa-IR', { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(project.stats.ai_cost_usd)} دلار` : '—'}</td></tr>
          </tbody>
        </table>
      ) : (
        <p className="muted small">در این پروژه از هوش مصنوعی استفاده نشد (کاملاً آفلاین و رایگان).</p>
      )}
      {aiUsageText(project.stats) && <p className="muted small">{aiUsageText(project.stats)}</p>}
    </section>
  );
}

export function StatsDialog({ questions, project, onClose }: { questions: Question[]; project?: Project; onClose: () => void }) {
  const { subjectName } = useAppData();
  const stats = useMemo(() => {
    const subj = new Map<string, number>();
    const topics = new Map<string, number>();
    const arts = new Map<string, number>();
    let noTopic = 0;
    let noArticle = 0;
    for (const q of questions) {
      const s = q.subject_key ?? '';
      subj.set(s, (subj.get(s) ?? 0) + 1);
      const t = (q.topic ?? '').trim();
      if (t) topics.set(t, (topics.get(t) ?? 0) + 1);
      else noTopic++;
      const list = q.articles ?? [];
      if (!list.length) noArticle++;
      const seen = new Set<string>();
      for (const a of list) {
        const label = articleLabel({ ...a, clause: '' });
        if (seen.has(label)) continue;
        seen.add(label);
        arts.set(label, (arts.get(label) ?? 0) + 1);
      }
    }
    return {
      subjects: top([...subj.entries()], 20),
      topics: top([...topics.entries()], 10),
      articles: top([...arts.entries()], 10),
      noTopic,
      noArticle,
    };
  }, [questions]);
  const total = questions.length || 1;
  const Bars = ({ rows, label }: { rows: [string, number][]; label: (k: string) => string }) => (
    <ul className="stat-bars">
      {rows.map(([k, n]) => (
        <li key={k}>
          <span className="stat-label" title={label(k)}>
            {label(k)}
          </span>
          <span className="stat-bar">
            <i style={{ width: `${Math.max(4, (n / total) * 100)}%` }} />
          </span>
          <span className="stat-num">{fa(n)}</span>
        </li>
      ))}
      {rows.length === 0 && <li className="muted small">هنوز موردی ثبت نشده.</li>}
    </ul>
  );
  return (
    <Modal title="آمار" onClose={onClose} wide footer={<button className="btn" onClick={onClose}>بستن</button>}>
      <div className="stats-grid" data-testid="stats">
        <section>
          <h3>سؤال‌ها به تفکیک درس</h3>
          <Bars rows={stats.subjects} label={(k) => subjectName(k || null)} />
        </section>
        <section>
          <h3>مباحث پرتکرار</h3>
          <Bars rows={stats.topics} label={(k) => k} />
          {stats.noTopic > 0 && <p className="muted small">{fa(stats.noTopic)} سؤال بدون مبحث</p>}
        </section>
        <section>
          <h3>مواد پراستناد</h3>
          <Bars rows={stats.articles} label={(k) => k} />
          {stats.noArticle > 0 && <p className="muted small">{fa(stats.noArticle)} سؤال بدون ماده</p>}
        </section>
        {project && <AiUsageSection project={project} />}
      </div>
    </Modal>
  );
}
