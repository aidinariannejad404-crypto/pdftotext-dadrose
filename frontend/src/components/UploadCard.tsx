import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { createProject } from '../api';
import { useAppData } from '../appData';
import type { Blueprint, EngineName, Track } from '../types';
import { ENGINE_LABELS, TRACK_LABELS, cx, fa, toAsciiDigits } from '../util';
import { Icon } from './Icons';
import { useToast } from './Toasts';

const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const ACCEPT = 'application/pdf,.pdf,image/*,.heic,.heif,.tif,.tiff';
const OK_EXT = /\.(pdf|jpe?g|png|webp|heic|heif|tiff?)$/i;
const THUMB_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

interface Picked {
  id: number;
  file: File;
  url: string | null; // object URL for image thumbnails
  pages: number | null; // images = 1, PDFs = counted if cheap
}

let seq = 0;

function isPdf(f: File) {
  return f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
}

/** Cheap page count: scan the PDF for "/Type /Page" objects (skipped for big files or compressed xref streams). */
async function countPdfPages(f: File): Promise<number | null> {
  if (f.size > 60 * 1024 * 1024) return null;
  try {
    const text = new TextDecoder('latin1').decode(await f.arrayBuffer());
    const n = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
    return n || null;
  } catch {
    return null;
  }
}

function mb(bytes: number) {
  const v = bytes / 1024 / 1024;
  return v < 0.1 ? `${fa(Math.max(1, Math.round(bytes / 1024)))} کیلوبایت` : `${fa(v.toFixed(1))} مگابایت`;
}

export function currentPersianYear(): number {
  try {
    const s = new Intl.DateTimeFormat('en-US-u-ca-persian', { year: 'numeric' }).format(new Date());
    const n = Number(s.replace(/\D/g, ''));
    if (n > 1300 && n < 1500) return n;
  } catch {
    /* ignore */
  }
  return 1404;
}

/** bar → BAR-<year> or latest bar; center → CENTER-<year> if it exists, else latest center; other → auto. */
export function pickBlueprint(blueprints: Blueprint[], track: Track, year: number | null): string {
  if (track === 'other') return 'auto';
  const same = blueprints.filter((b) => b.track === track);
  if (!same.length) return 'auto';
  const exact = year ? same.find((b) => b.year === year) : undefined;
  if (exact) return exact.code;
  return [...same].sort((a, b) => (b.year ?? 0) - (a.year ?? 0))[0].code;
}

function FileZone({
  label, hint, required, files, onChange, testId,
}: {
  label: string;
  hint: string;
  required?: boolean;
  files: Picked[];
  onChange: (f: Picked[]) => void;
  testId: string;
}) {
  const [over, setOver] = useState(false);
  const toast = useToast();
  const filesRef = useRef(files);
  filesRef.current = files;

  const add = async (list: FileList | File[] | null | undefined) => {
    if (!list) return;
    const all = Array.from(list);
    const bad = all.filter((f) => !OK_EXT.test(f.name) && !f.type.startsWith('image/') && !isPdf(f));
    if (bad.length) toast.error(`این فایل‌ها پذیرفته نشدند (فقط PDF یا عکس): ${bad.map((f) => f.name).join('، ')}`);
    const ok = all.filter((f) => !bad.includes(f));
    if (!ok.length) return;
    const picked: Picked[] = ok.map((file) => ({
      id: ++seq,
      file,
      url: THUMB_TYPES.includes(file.type) ? URL.createObjectURL(file) : null,
      pages: isPdf(file) ? null : 1,
    }));
    onChange([...filesRef.current, ...picked]);
    for (const p of picked.filter((x) => isPdf(x.file))) {
      const n = await countPdfPages(p.file);
      if (n) onChange(filesRef.current.map((x) => (x.id === p.id ? { ...x, pages: n } : x)));
    }
  };

  const remove = (p: Picked) => {
    if (p.url) URL.revokeObjectURL(p.url);
    onChange(files.filter((x) => x.id !== p.id));
  };
  const move = (i: number, d: number) => {
    const next = [...files];
    const [it] = next.splice(i, 1);
    next.splice(i + d, 0, it);
    onChange(next);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void add(e.dataTransfer.files);
  };

  const totalPages = files.every((f) => f.pages) ? files.reduce((s, f) => s + (f.pages ?? 0), 0) : null;

  return (
    <div
      className={cx('dropzone', over && 'is-over', files.length > 0 && 'has-file')}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      data-testid={testId}
    >
      <input
        type="file"
        accept={ACCEPT}
        multiple
        className="visually-hidden"
        id={`${testId}-input`}
        onChange={(e) => {
          void add(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="dropzone-top">
        <Icon name={files.length ? 'file' : 'upload'} className="dropzone-icon" />
        <div className="dropzone-text">
          <div className="dropzone-label">
            {label} {required ? <span className="req">(الزامی)</span> : <span className="muted">(اختیاری)</span>}
          </div>
          <div className="muted small">{hint}</div>
        </div>
        <label htmlFor={`${testId}-input`} className="btn btn-sm">
          <Icon name="plus" size={16} /> {files.length ? 'افزودن فایل' : 'انتخاب فایل'}
        </label>
      </div>
      {files.length === 0 ? (
        <div className="dropzone-empty muted small">فایل را اینجا بکشید و رها کنید</div>
      ) : (
        <>
          <ol className="file-list">
            {files.map((p, i) => (
              <li key={p.id} className="file-row" data-testid="file-row">
                <span className="file-order">{fa(i + 1)}</span>
                {p.url ? (
                  <img className="file-thumb" src={p.url} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
                ) : (
                  <span className="file-thumb file-thumb-icon">
                    <Icon name={isPdf(p.file) ? 'file' : 'image'} size={18} />
                  </span>
                )}
                <span className="file-info">
                  <span className="file-name" dir="auto" title={p.file.name}>
                    {p.file.name}
                  </span>
                  <span className="muted small">
                    {mb(p.file.size)}
                    {p.pages ? ` · ${fa(p.pages)} صفحه` : isPdf(p.file) ? ' · PDF' : ''}
                  </span>
                </span>
                {files.length > 1 && (
                  <span className="file-move">
                    <button type="button" className="btn btn-xs btn-icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`انتقال ${p.file.name} به بالا`} title="جابه‌جایی به بالا (صفحه‌ی قبل)">
                      <Icon name="chev-up" size={16} />
                    </button>
                    <button type="button" className="btn btn-xs btn-icon" onClick={() => move(i, 1)} disabled={i === files.length - 1} aria-label={`انتقال ${p.file.name} به پایین`} title="جابه‌جایی به پایین (صفحه‌ی بعد)">
                      <Icon name="chev-down" size={16} />
                    </button>
                  </span>
                )}
                <button type="button" className="btn btn-xs btn-icon btn-ghost" onClick={() => remove(p)} aria-label={`حذف ${p.file.name}`} title="حذف این فایل">
                  ×
                </button>
              </li>
            ))}
          </ol>
          <div className="small muted file-summary">
            {fa(files.length)} فایل
            {totalPages ? ` · حدود ${fa(totalPages)} صفحه` : ''}
            {files.length > 1 && ' · ترتیب فایل‌ها = ترتیب صفحه‌ها'}
          </div>
        </>
      )}
    </div>
  );
}

export default function UploadCard({ onCreated }: { onCreated: () => void }) {
  const { meta, health, engineAvailable } = useAppData();
  const toast = useToast();
  const [booklet, setBooklet] = useState<Picked[]>([]);
  const [explanations, setExplanations] = useState<Picked[]>([]);
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [track, setTrack] = useState<Track>('bar');
  const [year, setYear] = useState('');
  const [blueprintOverride, setBlueprintOverride] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineName>('auto');
  const [uploading, setUploading] = useState<number | null>(null);
  const [tried, setTried] = useState(false);

  const thisYear = useMemo(currentPersianYear, []);
  const yearNum = Number(toAsciiDigits(year).trim());
  const yearValid = /^1[34]\d\d$/.test(toAsciiDigits(year).trim());
  const autoBlueprint = pickBlueprint(meta?.blueprints ?? [], track, yearValid ? yearNum : null);
  const blueprint = blueprintOverride ?? autoBlueprint;
  const blueprintInfo = meta?.blueprints.find((b) => b.code === blueprint);

  const firstName = booklet[0]?.file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ') ?? '';
  const autoTitle = yearValid
    ? track === 'other'
      ? `آزمون ${fa(yearNum)}`
      : `آزمون ${TRACK_LABELS[track]} ${fa(yearNum)}`
    : firstName;
  const shownTitle = titleTouched ? title : autoTitle;

  useEffect(() => {
    if (!engineAvailable(engine)) setEngine('auto');
  }, [engine, engineAvailable]);

  const totalBytes = [...booklet, ...explanations].reduce((s, p) => s + p.file.size, 0);
  const missing: string[] = [];
  if (!booklet.length) missing.push('فایل دفترچه را انتخاب کنید');
  if (!yearValid) missing.push(year ? 'سال را درست وارد کنید (مثلاً ۱۴۰۴)' : 'سال آزمون را وارد کنید');
  if (totalBytes > MAX_TOTAL_BYTES) missing.push('حجم فایل‌ها بیش از ۲۰۰ مگابایت است');
  const canSubmit = missing.length === 0 && uploading === null;

  const reset = () => {
    [...booklet, ...explanations].forEach((p) => p.url && URL.revokeObjectURL(p.url));
    setBooklet([]);
    setExplanations([]);
    setTitle('');
    setTitleTouched(false);
    setYear('');
    setBlueprintOverride(null);
    setTried(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!canSubmit) return;
    const form = new FormData();
    booklet.forEach((p) => form.append('booklet', p.file, p.file.name));
    explanations.forEach((p) => form.append('explanations', p.file, p.file.name));
    form.append('title', (shownTitle || autoTitle || booklet[0].file.name).trim());
    form.append('track', track);
    form.append('year', String(yearNum));
    form.append('blueprint', blueprint);
    form.append('engine', engine);
    setUploading(0);
    try {
      await createProject(form, setUploading);
      toast.success('فایل‌ها بارگذاری شد و پردازش شروع شد. وقتی آماده شد، دکمه‌ی «بازبینی» فعال می‌شود.');
      reset();
      onCreated();
    } catch (err) {
      toast.error(err);
    } finally {
      setUploading(null);
    }
  };

  const engineHint = (en: EngineName) => {
    if (en === 'auto') {
      const d = health?.default_engine;
      return d ? `(پیش‌فرض: ${ENGINE_LABELS[d] ?? d})` : '';
    }
    return engineAvailable(en) ? '' : '(پیکربندی نشده)';
  };

  return (
    <form className="card upload-card" onSubmit={submit} aria-labelledby="upload-title" noValidate>
      <div className="card-head">
        <h2 id="upload-title" className="card-title">
          بارگذاری دفترچه‌ی جدید
        </h2>
      </div>

      <div className="dropzones">
        <FileZone
          label="دفترچه‌ی سؤالات"
          hint="PDF یا عکس (JPG، PNG، HEIC آیفون) — اسکن CamScanner هم قبول است. چند عکس را به ترتیب صفحه انتخاب کنید. حداکثر ۲۰۰ مگابایت."
          required
          files={booklet}
          onChange={setBooklet}
          testId="drop-booklet"
        />
        <FileZone
          label="پاسخ تشریحی"
          hint="فقط اگر پاسخ‌ها در فایل جداگانه‌اند. PDF یا عکس."
          files={explanations}
          onChange={setExplanations}
          testId="drop-explanations"
        />
      </div>

      <div className="form-grid">
        <fieldset className="field field-track">
          <legend className="field-label">
            آزمون <span className="req">(الزامی)</span>
          </legend>
          <div className="segmented segmented-lg" role="radiogroup" aria-label="آزمون">
            {(['bar', 'center', 'other'] as Track[]).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={track === t}
                className={cx('seg', track === t && 'is-on')}
                onClick={() => {
                  setTrack(t);
                  setBlueprintOverride(null);
                }}
              >
                {TRACK_LABELS[t]}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="field field-year">
          <label className="field-label" htmlFor="up-year">
            سال آزمون (شمسی) <span className="req">(الزامی)</span>
          </label>
          <div className="year-row">
            <input
              id="up-year"
              className={cx('input input-year', tried && !yearValid && 'is-invalid')}
              value={year}
              onChange={(e) => {
                setYear(e.target.value);
                setBlueprintOverride(null);
              }}
              inputMode="numeric"
              placeholder={fa(thisYear)}
              aria-invalid={tried && !yearValid}
              dir="ltr"
              maxLength={4}
            />
            {[thisYear, thisYear - 1, thisYear - 2, thisYear - 3].map((y) => (
              <button
                key={y}
                type="button"
                className={cx('btn btn-sm year-chip', yearNum === y && 'is-on')}
                onClick={() => {
                  setYear(String(y));
                  setBlueprintOverride(null);
                }}
              >
                {fa(y)}
              </button>
            ))}
          </div>
        </div>
        <label className="field field-wide">
          <span className="field-label">عنوان پروژه</span>
          <input
            className="input"
            value={shownTitle}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleTouched(true);
            }}
            placeholder="خودکار از روی آزمون و سال"
            data-testid="title-input"
          />
          {!titleTouched && autoTitle && <span className="field-hint">عنوان خودکار ساخته شد؛ در صورت نیاز تغییر دهید.</span>}
        </label>
      </div>

      <details className="advanced">
        <summary>
          تنظیمات پیشرفته
          <span className="muted small">
            {' '}
            — الگو: {blueprint === 'auto' ? 'خودکار' : blueprintInfo?.title ?? blueprint} · موتور: {ENGINE_LABELS[engine]}
          </span>
        </summary>
        <div className="form-grid advanced-grid">
          <label className="field">
            <span className="field-label">الگوی آزمون (تعداد و ترتیب درس‌ها)</span>
            <select className="input" value={blueprint} onChange={(e) => setBlueprintOverride(e.target.value)} data-testid="blueprint-select">
              <option value="auto">خودکار — تشخیص از روی عنوان درس‌ها</option>
              {meta?.blueprints.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.title} ({fa(b.question_count)} سؤال)
                </option>
              ))}
            </select>
            <span className="field-hint">به‌طور خودکار از روی آزمون و سال انتخاب می‌شود.</span>
          </label>
          <label className="field">
            <span className="field-label">موتور خواندن متن</span>
            <select className="input" value={engine} onChange={(e) => setEngine(e.target.value as EngineName)}>
              {(['auto', 'offline', 'claude', 'gemini'] as EngineName[]).map((en) => (
                <option key={en} value={en} disabled={!engineAvailable(en)}>
                  {ENGINE_LABELS[en]} {engineHint(en)}
                </option>
              ))}
            </select>
            {health && !health.engines.claude && !health.engines.gemini ? (
              <span className="field-hint">هیچ موتور هوش مصنوعی پیکربندی نشده؛ فقط خواندن آفلاین (دقت کمتر) در دسترس است.</span>
            ) : (
              <span className="field-hint">«خودکار» برای بیشتر فایل‌ها بهترین نتیجه را می‌دهد.</span>
            )}
          </label>
        </div>
      </details>

      <div className="card-foot">
        {uploading !== null ? (
          <div className="upload-progress" aria-live="polite">
            <div className="bar">
              <div className="bar-fill" style={{ width: `${Math.round(uploading * 100)}%` }} />
            </div>
            <span className="small muted">در حال بارگذاری… {fa(Math.round(uploading * 100))}٪</span>
          </div>
        ) : (
          missing.length > 0 && (
            <div className={cx('submit-reason small', tried ? 'text-danger' : 'muted')} id="submit-reason" data-testid="submit-reason">
              برای شروع: {missing.join('، ')}.
            </div>
          )
        )}
        <button
          type="submit"
          className="btn btn-primary btn-lg"
          aria-disabled={!canSubmit}
          aria-describedby={missing.length ? 'submit-reason' : undefined}
          title={missing.length ? missing.join('، ') : undefined}
          data-testid="submit-upload"
        >
          <Icon name="upload" /> شروع پردازش
        </button>
      </div>
    </form>
  );
}
