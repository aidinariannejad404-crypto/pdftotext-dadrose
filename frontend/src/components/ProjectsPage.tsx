import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { ProjectSummary } from '../types';
import { STAGE_LABELS, STATUS_LABELS, TRACK_LABELS, cx, etaText, fa, formatDate, percent, storageGet, storageSet } from '../util';
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

function ProjectRow({ p, onDelete }: { p: ProjectSummary; onDelete: (p: ProjectSummary) => void }) {
  const busy = p.status === 'queued' || p.status === 'processing';
  const pct = percent(p.progress.done, p.progress.total);
  const approvedPct = percent(p.approved_count, p.question_count);
  return (
    <li className="project-row" data-testid="project-row">
      <div className="project-main">
        <a href={`#/p/${encodeURIComponent(p.id)}`} className="project-title">
          {p.title}
        </a>
        <div className="project-meta small muted">
          <span>{TRACK_LABELS[p.track] ?? p.track}</span>
          {p.year && <span>{fa(p.year)}</span>}
          <span>{formatDate(p.created_at)}</span>
        </div>
      </div>
      <div className="project-status">
        <StatusChip status={p.status} stage={p.progress.stage} />
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
        {p.status === 'ready' && (
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
          {p.status === 'ready' ? (p.approved_count === p.question_count && p.question_count > 0 ? 'مشاهده و دانلود' : 'بازبینی') : 'مشاهده'}
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
        <UploadCard onCreated={load} />
        <section className="card" aria-labelledby="list-title">
          <div className="card-head">
            <h2 id="list-title" className="card-title">
              پروژه‌ها
            </h2>
            {projects && <span className="muted small">{fa(projects.length)} پروژه</span>}
          </div>
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
              {projects.map((p) => (
                <ProjectRow key={p.id} p={p} onDelete={setToDelete} />
              ))}
            </ul>
          )}
        </section>
      </main>
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
