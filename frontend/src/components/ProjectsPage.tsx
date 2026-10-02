import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api, createProject } from '../api';
import { useAppData } from '../appData';
import type { EngineName, ProjectSummary, Track } from '../types';
import { ENGINE_LABELS, STAGE_LABELS, STATUS_LABELS, TRACK_LABELS, cx, fa, formatDate, percent, toAsciiDigits } from '../util';
import { navigate } from '../App';
import Modal from './Modal';
import { useToast } from './Toasts';
import { BrandMark, Icon } from './Icons';

function DropZone({
  label, hint, required, file, onFile, testId,
}: {
  label: string;
  hint: string;
  required?: boolean;
  file: File | null;
  onFile: (f: File | null) => void;
  testId: string;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const accept = (f: File | undefined) => {
    if (!f) return;
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      toast.error('فقط فایل PDF پذیرفته می‌شود.');
      return;
    }
    onFile(f);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    accept(e.dataTransfer.files?.[0]);
  };

  return (
    <div
      className={cx('dropzone', over && 'is-over', file && 'has-file')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      data-testid={testId}
    >
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="visually-hidden"
        id={`${testId}-input`}
        onChange={(e) => {
          accept(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <Icon name={file ? 'file' : 'upload'} className="dropzone-icon" />
      <div className="dropzone-text">
        <div className="dropzone-label">
          {label} {required ? <span className="req" aria-hidden>*</span> : <span className="muted">(اختیاری)</span>}
        </div>
        {file ? (
          <div className="dropzone-file" dir="auto">
            {file.name} <span className="muted">— {fa((file.size / 1024 / 1024).toFixed(1))} مگابایت</span>
          </div>
        ) : (
          <div className="muted small">{hint}</div>
        )}
      </div>
      <div className="dropzone-actions">
        <label htmlFor={`${testId}-input`} className="btn btn-sm">
          {file ? 'تغییر' : 'انتخاب فایل'}
        </label>
        {file && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onFile(null)} aria-label={`حذف ${label}`}>
            حذف
          </button>
        )}
      </div>
    </div>
  );
}

function UploadCard({ onCreated }: { onCreated: () => void }) {
  const { meta, health, engineAvailable } = useAppData();
  const toast = useToast();
  const [booklet, setBooklet] = useState<File | null>(null);
  const [explanations, setExplanations] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [track, setTrack] = useState<Track>('bar');
  const [year, setYear] = useState('');
  const [blueprint, setBlueprint] = useState('auto');
  const [engine, setEngine] = useState<EngineName>('auto');
  const [uploading, setUploading] = useState<number | null>(null);

  useEffect(() => {
    if (!engineAvailable(engine)) setEngine('auto');
  }, [engine, engineAvailable]);

  useEffect(() => {
    if (booklet && !title) setTitle(booklet.name.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' '));
  }, [booklet, title]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!booklet) {
      toast.error('فایل PDF دفترچه را انتخاب کنید.');
      return;
    }
    const form = new FormData();
    form.append('booklet', booklet);
    if (explanations) form.append('explanations', explanations);
    form.append('title', title.trim() || booklet.name);
    form.append('track', track);
    const y = toAsciiDigits(year).trim();
    if (y) form.append('year', y);
    form.append('blueprint', blueprint);
    form.append('engine', engine);
    setUploading(0);
    try {
      const p = await createProject(form, setUploading);
      toast.success('فایل‌ها بارگذاری شد؛ پردازش آغاز شد.');
      setBooklet(null);
      setExplanations(null);
      setTitle('');
      setYear('');
      onCreated();
      void p;
    } catch (err) {
      toast.error(err);
    } finally {
      setUploading(null);
    }
  };

  const engineHint = (e: EngineName) => {
    if (e === 'auto') {
      const d = health?.default_engine;
      return d ? `پیش‌فرض: ${ENGINE_LABELS[d] ?? d}` : '';
    }
    return engineAvailable(e) ? '' : '(پیکربندی نشده)';
  };
  const yearInvalid = year !== '' && !/^1[34]\d\d$/.test(toAsciiDigits(year).trim());

  return (
    <form className="card upload-card" onSubmit={submit} aria-labelledby="upload-title">
      <div className="card-head">
        <h2 id="upload-title" className="card-title">
          پروژه‌ی جدید
        </h2>
        <span className="muted small">دفترچه‌ی آزمون (PDF تایپی یا اسکن موبایل) را بارگذاری کنید.</span>
      </div>
      <div className="dropzones">
        <DropZone
          label="دفترچه‌ی سؤالات"
          hint="فایل را اینجا رها کنید یا انتخاب کنید"
          required
          file={booklet}
          onFile={setBooklet}
          testId="drop-booklet"
        />
        <DropZone
          label="پاسخ تشریحی"
          hint="اگر پاسخ‌ها در فایل جداگانه‌اند"
          file={explanations}
          onFile={setExplanations}
          testId="drop-explanations"
        />
      </div>
      <div className="form-grid">
        <label className="field field-wide">
          <span className="field-label">عنوان</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثلاً آزمون کانون وکلا ۱۴۰۳" />
        </label>
        <label className="field">
          <span className="field-label">آزمون</span>
          <select className="input" value={track} onChange={(e) => setTrack(e.target.value as Track)}>
            {(['bar', 'center', 'other'] as Track[]).map((t) => (
              <option key={t} value={t}>
                {TRACK_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">سال (شمسی)</span>
          <input
            className={cx('input', yearInvalid && 'is-invalid')}
            value={year}
            onChange={(e) => setYear(e.target.value)}
            inputMode="numeric"
            placeholder="۱۴۰۳"
            aria-invalid={yearInvalid}
            dir="ltr"
          />
        </label>
        <label className="field">
          <span className="field-label">الگوی آزمون</span>
          <select className="input" value={blueprint} onChange={(e) => setBlueprint(e.target.value)}>
            <option value="auto">خودکار — تشخیص از روی عنوان درس‌ها</option>
            {meta?.blueprints.map((b) => (
              <option key={b.code} value={b.code}>
                {b.title} ({fa(b.question_count)} سؤال)
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">موتور خواندن متن</span>
          <select className="input" value={engine} onChange={(e) => setEngine(e.target.value as EngineName)}>
            {(['auto', 'offline', 'claude', 'gemini'] as EngineName[]).map((e) => (
              <option key={e} value={e} disabled={!engineAvailable(e)}>
                {ENGINE_LABELS[e]} {engineHint(e)}
              </option>
            ))}
          </select>
          {health && !health.engines.claude && !health.engines.gemini && (
            <span className="field-hint">هیچ موتور هوش مصنوعی پیکربندی نشده؛ فقط OCR آفلاین در دسترس است.</span>
          )}
          {!health && <span className="field-hint">وضعیت موتورها دریافت نشد.</span>}
        </label>
      </div>
      <div className="card-foot">
        {uploading !== null && (
          <div className="upload-progress" aria-live="polite">
            <div className="bar">
              <div className="bar-fill" style={{ width: `${Math.round(uploading * 100)}%` }} />
            </div>
            <span className="small muted">در حال بارگذاری… {fa(Math.round(uploading * 100))}٪</span>
          </div>
        )}
        <button type="submit" className="btn btn-primary" disabled={!booklet || uploading !== null}>
          <Icon name="upload" /> شروع پردازش
        </button>
      </div>
    </form>
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
            {p.progress.total > 0 && (
              <span className="small muted">
                {fa(p.progress.done)} از {fa(p.progress.total)} صفحه
              </span>
            )}
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
        <button className="btn btn-sm" onClick={() => navigate(`#/p/${encodeURIComponent(p.id)}`)}>
          {p.status === 'ready' ? 'بازبینی' : 'مشاهده'}
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
      </header>
      <main className="container">
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
          {projects && projects.length === 0 && <div className="empty muted">هنوز پروژه‌ای ساخته نشده است.</div>}
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
                حذف
              </button>
              <button className="btn" onClick={() => setToDelete(null)}>
                انصراف
              </button>
            </>
          }
        >
          <p>
            پروژه‌ی «{toDelete.title}» و همه‌ی ویرایش‌های آن برای همیشه حذف می‌شود. ادامه می‌دهید؟
          </p>
        </Modal>
      )}
    </div>
  );
}
