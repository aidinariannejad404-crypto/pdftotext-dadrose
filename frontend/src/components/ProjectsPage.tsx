import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, exportZipUrl } from '../api';
import { useAppData } from '../appData';
import type { PushApprovedItem, ProjectSummary } from '../types';
import { STAGE_LABELS, STATUS_LABELS, TRACK_LABELS, cx, etaText, fa, formatDate, percent, aiUsageText, statsText, storageGet, storageSet } from '../util';
import { navigate } from '../App';
import Modal from './Modal';
import { useToast } from './Toasts';
import { BrandMark, Icon } from './Icons';
import UploadCard from './UploadCard';

const GUIDE_KEY = 'dadrose.guide.dismissed';

const GUIDE_STEPS: { title: string; text: string; icon: string }[] = [
  { title: 'بارگذاری فایل', text: 'PDF یا عکس‌های دفترچه را انتخاب کنید؛ متن صفحه‌ها خودکار خوانده می‌شود.', icon: 'upload' },
  { title: 'بازبینی و تأیید سؤال‌ها', text: 'هر سؤال را با تصویر صفحه مقایسه کنید، اشتباهات را اصلاح و تأیید کنید.', icon: 'check' },
  { title: 'دانلود Word و ورود در سایت', text: 'فایل Word را دانلود و در پنل سایت در «ورود هوشمند از ورد» بارگذاری کنید.', icon: 'download' },
];

function Guide({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section className="card guide" aria-labelledby="guide-title" data-testid="guide">
      <div className="card-head">
        <h2 id="guide-title" className="card-title">
          چطور کار می‌کند؟
        </h2>
        <button className="btn btn-sm btn-ghost guide-close" onClick={onDismiss} aria-label="بستن راهنما" title="بستن راهنما">
          ×
        </button>
      </div>
      <ol className="guide-steps">
        {GUIDE_STEPS.map((s, i) => (
          <li key={i} className="guide-step">
            <span className="guide-num">{fa(i + 1)}</span>
            <div>
              <div className="guide-title">{s.title}</div>
              <div className="muted small">{s.text}</div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function StatusChip({ status, stage }: { status: string; stage?: string }) {
  const label = status === 'processing' && stage ? STAGE_LABELS[stage] ?? STATUS_LABELS[status] : STATUS_LABELS[status] ?? status;
  return <span className={`chip chip-status chip-${status}`}>{label}</span>;
}

function ProjectRow({
  p, onDelete, selected, onToggle,
}: {
  p: ProjectSummary;
  onDelete: (p: ProjectSummary) => void;
  selected: boolean;
  onToggle: () => void;
}) {
  const busy = p.status === 'queued' || p.status === 'processing';
  const pct = percent(p.progress.done, p.progress.total);
  const approvedPct = percent(p.approved_count, p.mode === 'text' ? p.page_count ?? 0 : p.question_count);
  const done = p.mode === 'text' ? (p.page_count ?? 0) > 0 && p.approved_count === p.page_count : p.approved_count === p.question_count && p.question_count > 0;
  return (
    <li className={cx('project-row', selected && 'is-selected')} data-testid="project-row">
      <label className="project-select" title={p.status === 'ready' ? 'انتخاب برای کارهای گروهی' : 'فقط پروژه‌های آماده قابل انتخاب‌اند'}>
        <input type="checkbox" checked={selected} onChange={onToggle} disabled={p.status !== 'ready'} aria-label={`انتخاب ${p.title}`} />
      </label>
      <div className="project-main">
        <a href={`#/p/${encodeURIComponent(p.id)}`} className="project-title">
          {p.title}
        </a>
        <div className="project-meta small muted">
          <span>{TRACK_LABELS[p.track] ?? p.track}</span>
          {p.year && <span>{fa(p.year)}</span>}
          <span>{formatDate(p.created_at)}</span>
          {p.status === 'ready' && p.stats && statsText(p.stats) && <span data-testid="project-stats">{statsText(p.stats)}</span>}
          {p.status === 'ready' && aiUsageText(p.stats) && <span data-testid="project-ai">{aiUsageText(p.stats)}</span>}
        </div>
      </div>
      <div className="project-status">
        <span className="row-gap">
          <StatusChip status={p.status} stage={p.progress.stage} />
          {p.status === 'queued' && p.queue_position ? (
            <span className="chip chip-queued" data-testid="queue-position">
              در صف: نفر {fa(p.queue_position)}
            </span>
          ) : null}
        </span>
        {busy && (
          <div className="project-progress">
            <div className="bar bar-sm" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className={cx('bar-fill', p.progress.total === 0 && 'is-indeterminate')} style={{ width: `${pct || 0}%` }} />
            </div>
            <span className="small muted">
              {p.progress.total > 0 ? `${fa(p.progress.done)} از ${fa(p.progress.total)} صفحه · ` : ''}
              {p.progress.total > 0 ? `باقی‌مانده: ${etaText(p.progress.total - p.progress.done)}` : 'در حال آماده‌سازی…'}
            </span>
          </div>
        )}
        {p.status === 'failed' && p.error && <div className="small text-danger">{p.error}</div>}
      </div>
      <div className="project-counts">
        {p.status === 'ready' && p.mode === 'text' && (
          <>
            <div className="count">
              <span className="count-num">{fa(p.page_count ?? 0)}</span>
              <span className="count-label">صفحه‌ها</span>
            </div>
            <div className="count count-success">
              <span className="count-num">{fa(p.approved_count)}</span>
              <span className="count-label">تأییدشده</span>
            </div>
            <div className="count">
              <span className="chip chip-neutral">متن کامل</span>
            </div>
            <div className="bar bar-sm count-bar" title={`${fa(approvedPct)}٪ تأیید شده`}>
              <div className="bar-fill bar-success" style={{ width: `${approvedPct}%` }} />
            </div>
          </>
        )}
        {p.status === 'ready' && p.mode !== 'text' && (
          <>
            <div className="count">
              <span className="count-num">{fa(p.question_count)}</span>
              <span className="count-label">سؤال‌ها</span>
            </div>
            <div className="count count-success">
              <span className="count-num">{fa(p.approved_count)}</span>
              <span className="count-label">تأییدشده</span>
            </div>
            <div className={cx('count', p.error_count > 0 && 'count-danger')}>
              <span className="count-num">{fa(p.error_count)}</span>
              <span className="count-label">خطا</span>
            </div>
            {((p.auto_approved_count ?? 0) > 0 || (p.duplicate_count ?? 0) > 0) && (
              <div className="count-extra small muted">
                {(p.auto_approved_count ?? 0) > 0 && <span>{fa(p.auto_approved_count!)} خودکار تأییدشده</span>}
                {(p.duplicate_count ?? 0) > 0 && <span className="text-warning">{fa(p.duplicate_count!)} تکراری</span>}
              </div>
            )}
            <div className="bar bar-sm count-bar" title={`${fa(approvedPct)}٪ تأیید شده`}>
              <div className="bar-fill bar-success" style={{ width: `${approvedPct}%` }} />
            </div>
          </>
        )}
      </div>
      <div className="project-actions">
        <button
          className={cx('btn btn-sm', p.status === 'ready' && 'btn-primary')}
          onClick={() => navigate(`#/p/${encodeURIComponent(p.id)}`)}
        >
          {p.status === 'ready' ? (done ? 'مشاهده و دانلود' : 'بازبینی') : 'مشاهده'}
        </button>
        <button className="btn btn-sm btn-ghost btn-icon" onClick={() => onDelete(p)} aria-label={`حذف ${p.title}`} title="حذف">
          <Icon name="trash" />
        </button>
      </div>
    </li>
  );
}

export default function ProjectsPage() {
  const toast = useToast();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<ProjectSummary | null>(null);
  const { health } = useAppData();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);
  const [pushResults, setPushResults] = useState<PushApprovedItem[] | null>(null);
  const listRef = useRef<HTMLElement>(null);
  const [guideOpen, setGuideOpen] = useState(() => storageGet(GUIDE_KEY) !== '1');
  const dismissGuide = () => {
    setGuideOpen(false);
    storageSet(GUIDE_KEY, '1');
  };

  const load = useCallback(async () => {
    try {
      setProjects(await api.projects());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    document.title = 'دادرس — پروژه‌ها';
  }, [load]);

  const anyBusy = projects?.some((p) => p.status === 'queued' || p.status === 'processing') ?? false;
  useEffect(() => {
    if (!anyBusy) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [anyBusy, load]);

  // Group rows by batch (single uploads are their own group), newest first.
  const groups = useMemo(() => {
    const out: { key: string; batch: string | null; items: ProjectSummary[] }[] = [];
    const idx = new Map<string, number>();
    for (const p of projects ?? []) {
      if (p.batch_id) {
        if (!idx.has(p.batch_id)) {
          idx.set(p.batch_id, out.length);
          out.push({ key: p.batch_id, batch: p.batch_id, items: [] });
        }
        out[idx.get(p.batch_id)!].items.push(p);
      } else out.push({ key: p.id, batch: null, items: [p] });
    }
    for (const g of out) g.items.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return out;
  }, [projects]);

  useEffect(() => {
    if (!highlight) return;
    const el = listRef.current?.querySelector(`[data-batch="${highlight}"]`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const t = setTimeout(() => setHighlight(null), 6000);
    return () => clearTimeout(t);
  }, [highlight, groups.length]);

  const toggle = (id: string) =>
    setSelected((s0) => {
      const s1 = new Set(s0);
      if (s1.has(id)) s1.delete(id);
      else s1.add(id);
      return s1;
    });
  const selectedReady = (projects ?? []).filter((p) => selected.has(p.id) && p.status === 'ready');
  const selectedQuestions = selectedReady.filter((p) => p.mode !== 'text');

  const bulkAutoApprove = async () => {
    setBulkBusy('auto');
    let total = 0;
    try {
      for (const p of selectedQuestions) total += (await api.autoApprove(p.id)).approved;
      toast.success(`${fa(total)} سؤال سالم در ${fa(selectedQuestions.length)} پروژه خودکار تأیید شد.`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBulkBusy(null);
      void load();
    }
  };

  const bulkPush = async () => {
    setBulkBusy('push');
    try {
      setPushResults(await api.pushApproved(selectedQuestions.map((p) => p.id)));
    } catch (err) {
      toast.error(err);
    } finally {
      setBulkBusy(null);
    }
  };

  const bulkWord = async () => {
    // One ZIP of Word files (approved questions; full text for text projects). Fetch first so a
    // 400 «nothing to export» shows as a toast instead of a broken download.
    setBulkBusy('word');
    const url = exportZipUrl(selectedReady.map((p) => p.id), true);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        let detail = `خطای سرور (${res.status})`;
        try {
          const j = (await res.json()) as { detail?: unknown };
          if (typeof j.detail === 'string') detail = j.detail;
        } catch {
          /* not JSON */
        }
        throw new Error(detail);
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `dadrose-${selectedReady.length}-projects.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      toast.success(`فایل ZIP شامل Word ${fa(selectedReady.length)} پروژه دانلود شد.`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBulkBusy(null);
    }
  };

  const running = (projects ?? []).filter((p) => p.status === 'processing').length;
  const queued = (projects ?? []).filter((p) => p.status === 'queued').length;

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      await api.deleteProject(toDelete.id);
      toast.success('پروژه حذف شد.');
      setToDelete(null);
      void load();
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">دادرس</div>
            <div className="brand-sub">تبدیل دفترچه‌ی آزمون به سؤال</div>
          </div>
        </div>
        <span className="spacer" />
        <a className="btn btn-sm btn-ghost topbar-btn" href="#/queue" data-testid="nav-queue">
          <Icon name="list" size={16} /> صف بازبینی
        </a>
        {!guideOpen && (
          <button
            className="btn btn-sm btn-ghost topbar-btn"
            onClick={() => {
              setGuideOpen(true);
              storageSet(GUIDE_KEY, '0');
            }}
          >
            <span className="help-q" aria-hidden="true">؟</span> راهنما
          </button>
        )}
      </header>
      <main className="container">
        {guideOpen && <Guide onDismiss={dismissGuide} />}
        <UploadCard
          onCreated={(batchId) => {
            if (batchId) setHighlight(batchId);
            void load();
          }}
        />
        <section className="card" aria-labelledby="list-title" ref={listRef}>
          <div className="card-head">
            <h2 id="list-title" className="card-title">
              پروژه‌ها
            </h2>
            {projects && <span className="muted small">{fa(projects.length)} پروژه</span>}
            {(running > 0 || queued > 0) && (
              <span className="chip chip-processing" data-testid="queue-summary">
                در حال پردازش: {fa(running)} · در صف: {fa(queued)}
              </span>
            )}
          </div>
          {selected.size > 0 && (
            <div className="bulk-bar" role="toolbar" aria-label="کارهای گروهی" data-testid="bulk-bar">
              <b>{fa(selectedReady.length)} پروژه انتخاب شد</b>
              <button className="btn btn-sm" onClick={bulkAutoApprove} disabled={!selectedQuestions.length || bulkBusy !== null} data-testid="bulk-auto">
                <Icon name="check" size={16} /> {bulkBusy === 'auto' ? 'در حال تأیید…' : 'تأیید خودکار سالم‌ها'}
              </button>
              <button className="btn btn-sm btn-word" onClick={bulkWord} disabled={!selectedReady.length || bulkBusy !== null} data-testid="bulk-word">
                <Icon name="download" size={16} /> {bulkBusy === 'word' ? 'در حال آماده‌سازی…' : 'دانلود Word همه (ZIP)'}
              </button>
              {health?.push_configured && (
                <button className="btn btn-sm" onClick={bulkPush} disabled={!selectedQuestions.length || bulkBusy !== null} data-testid="bulk-push">
                  <Icon name="send" size={16} /> {bulkBusy === 'push' ? 'در حال ارسال…' : 'ارسال تأییدشده‌ها به سایت'}
                </button>
              )}
              <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
                لغو انتخاب
              </button>
            </div>
          )}
          {loadError && (
            <div className="alert alert-danger">
              {loadError}{' '}
              <button className="btn btn-sm" onClick={load}>
                تلاش دوباره
              </button>
            </div>
          )}
          {!projects && !loadError && <div className="empty muted">در حال بارگذاری…</div>}
          {projects && projects.length === 0 && (
            <div className="empty-state" data-testid="empty-state">
              <Icon name="file" size={40} className="empty-icon" />
              <div className="empty-title">هنوز پروژه‌ای نساخته‌اید</div>
              <div className="muted">اولین دفترچه را از بخش بالا بارگذاری کنید؛ پس از پردازش، اینجا نمایش داده می‌شود.</div>
            </div>
          )}
          {projects && projects.length > 0 && (
            <ul className="project-list">
              {groups.map((g) => {
                if (!g.batch) {
                  const p = g.items[0];
                  return <ProjectRow key={p.id} p={p} onDelete={setToDelete} selected={selected.has(p.id)} onToggle={() => toggle(p.id)} />;
                }
                const ready = g.items.filter((p) => p.status === 'ready');
                const waiting = g.items.filter((p) => p.status === 'queued' || p.status === 'processing').length;
                const failed = g.items.filter((p) => p.status === 'failed').length;
                const open = !collapsed.has(g.key);
                const allSel = ready.length > 0 && ready.every((p) => selected.has(p.id));
                return (
                  <li key={g.key} className={cx('batch-group', highlight === g.batch && 'is-highlight')} data-batch={g.batch} data-testid="batch-group">
                    <div className="batch-head">
                      <input
                        type="checkbox"
                        checked={allSel}
                        disabled={!ready.length}
                        onChange={() =>
                          setSelected((s0) => {
                            const s1 = new Set(s0);
                            for (const p of ready) {
                              if (allSel) s1.delete(p.id);
                              else s1.add(p.id);
                            }
                            return s1;
                          })
                        }
                        aria-label="انتخاب همه‌ی پروژه‌های آماده‌ی این گروه"
                      />
                      <button
                        className="batch-toggle-btn"
                        onClick={() =>
                          setCollapsed((c0) => {
                            const c1 = new Set(c0);
                            if (c1.has(g.key)) c1.delete(g.key);
                            else c1.add(g.key);
                            return c1;
                          })
                        }
                        aria-expanded={open}
                        data-testid="batch-head"
                      >
                        <Icon name={open ? 'chev-down' : 'chev-left'} size={16} />
                        <b>گروه {fa(g.items.length)} فایل</b>
                        <span className="muted small">
                          · {fa(ready.length)} آماده{waiting ? ` · ${fa(waiting)} در صف` : ''}
                          {failed ? ` · ${fa(failed)} ناموفق` : ''} · {formatDate(g.items[0].created_at)}
                        </span>
                      </button>
                    </div>
                    {open && (
                      <ul className="project-list batch-items">
                        {g.items.map((p) => (
                          <ProjectRow key={p.id} p={p} onDelete={setToDelete} selected={selected.has(p.id)} onToggle={() => toggle(p.id)} />
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
      {pushResults && (
        <Modal title="نتیجه‌ی ارسال به سایت" onClose={() => setPushResults(null)} footer={<button className="btn" onClick={() => setPushResults(null)}>بستن</button>}>
          <ul className="push-results" data-testid="push-results">
            {pushResults.map((r) => {
              const title = projects?.find((p) => p.id === r.project_id)?.title ?? r.project_id;
              return (
                <li key={r.project_id} className={r.ok ? 'text-success' : 'text-danger'}>
                  {r.ok ? '✓' : '✗'} {title}: {r.ok ? `${fa(r.questions)} سؤال فرستاده شد` : r.detail || 'ناموفق'}
                </li>
              );
            })}
          </ul>
          <p className="muted small">سؤال‌ها را در پنل سایت، بخش «ورود هوشمند از ورد» بازبینی و ثبت نهایی کنید.</p>
        </Modal>
      )}
      {toDelete && (
        <Modal
          title="حذف پروژه"
          tone="danger"
          onClose={() => setToDelete(null)}
          footer={
            <>
              <button className="btn btn-danger" onClick={confirmDelete}>
                بله، حذف شود
              </button>
              <button className="btn" onClick={() => setToDelete(null)}>
                انصراف
              </button>
            </>
          }
        >
          <p>
            پروژه‌ی «{toDelete.title}» و همه‌ی ویرایش‌ها و تأییدهای آن برای همیشه حذف می‌شود. این کار قابل بازگشت نیست.
          </p>
        </Modal>
      )}
    </div>
  );
}
