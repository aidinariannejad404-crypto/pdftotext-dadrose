import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, exportUrl } from '../api';
import { useAppData } from '../appData';
import { clearPageCache } from '../pageCache';
import type { DocKind, EngineName, Flag, Line, Project, Question, Word } from '../types';
import { useDraft } from '../useDraft';
import {
  ENGINE_LABELS, STAGE_LABELS, TRACK_LABELS, computeMarks, cx, fa, getFieldText, percent, questionState, toAsciiDigits,
} from '../util';
import Editor from './Editor';
import { BrandMark, Icon } from './Icons';
import Modal from './Modal';
import Navigator, { type NavFilter } from './Navigator';
import PageViewer, { type FocusTarget } from './PageViewer';
import { StatusChip } from './ProjectsPage';
import { useToast } from './Toasts';

type MobileTab = 'list' | 'text' | 'image';
type Dialog =
  | { kind: 'reocr' }
  | { kind: 'reparse' }
  | { kind: 'push' }
  | { kind: 'add' }
  | { kind: 'delete' }
  | null;

function readQueryNumber(): number | null {
  const m = /[?&]q=(\d+)/.exec(window.location.hash);
  return m ? Number(m[1]) : null;
}

function writeQueryNumber(id: string, n: number) {
  const hash = `#/p/${encodeURIComponent(id)}?q=${n}`;
  if (window.location.hash !== hash) history.replaceState(null, '', hash);
}

const stripPunct = (s: string) => s.replace(/^[.،؛:؟!«»()"'\-–—]+|[.،؛:؟!«»()"'\-–—]+$/g, '');

export default function ReviewPage({ id }: { id: string }) {
  const toast = useToast();
  const { meta, health, engineAvailable } = useAppData();
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [current, setCurrent] = useState<number | null>(readQueryNumber);
  const [version, setVersion] = useState(0); // bump when the current question is replaced externally
  const [filter, setFilter] = useState<NavFilter>('all');
  const [activeFlag, setActiveFlag] = useState<number | null>(null);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const [tab, setTab] = useState<MobileTab>('text');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [onlyApproved, setOnlyApproved] = useState(true);
  const fieldRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const focusNonce = useRef(0);

  // ------------------------------------------------------------------ loading
  const load = useCallback(async () => {
    try {
      const p = await api.project(id);
      setProject(p);
      setLoadError(null);
      return p;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const processing = project?.status === 'queued' || project?.status === 'processing';
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [processing, load]);

  useEffect(() => {
    if (project) document.title = `دادرس — ${project.title}`;
  }, [project]);

  const questions = useMemo(
    () => [...(project?.questions ?? [])].sort((a, b) => a.number - b.number),
    [project?.questions],
  );
  const question = questions.find((q) => q.number === current) ?? null;
  const hasExplanations = project?.documents.some((d) => d.kind === 'explanations' && d.page_count > 0) ?? false;

  // Pick a starting question once ready: first not-approved (or the one from the URL).
  useEffect(() => {
    if (project?.status !== 'ready' || !questions.length) return;
    if (current !== null && questions.some((q) => q.number === current)) return;
    const first = questions.find((q) => q.status !== 'approved') ?? questions[0];
    setCurrent(first.number);
  }, [project?.status, questions, current]);

  const replaceQuestion = useCallback((q: Question) => {
    setProject((p) => (p ? { ...p, questions: p.questions.map((x) => (x.number === q.number ? q : x)) } : p));
  }, []);

  const draftApi = useDraft(id, question, `${question?.number ?? 'none'}:${version}`, replaceQuestion, (err) => toast.error(err));
  const { draft, state: saveState, update, setOption, flush, saveWith } = draftApi;

  // Merge draft into the current question for display (navigator colors etc. stay server-driven).
  const register = useCallback((field: string, el: HTMLTextAreaElement | null) => {
    if (el) fieldRefs.current.set(field, el);
    else fieldRefs.current.delete(field);
  }, []);

  // Switch the viewer to the question's first region when the question changes.
  useEffect(() => {
    if (!question) return;
    writeQueryNumber(id, question.number);
    setActiveFlag(null);
    const r = question.regions.find((x) => x.doc === 'booklet') ?? question.regions[0];
    if (r) setFocus({ doc: r.doc, page: r.page, bbox: r.bbox, nonce: ++focusNonce.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question?.number, version, id]);

  // --------------------------------------------------------------- navigation
  const select = useCallback(
    async (n: number) => {
      if (n === current) return;
      await flush();
      setCurrent(n);
      setTab((t) => (t === 'list' ? 'text' : t));
    },
    [current, flush],
  );

  const idx = question ? questions.findIndex((q) => q.number === question.number) : -1;
  const goRel = useCallback(
    (delta: number) => {
      const next = questions[idx + delta];
      if (next) void select(next.number);
    },
    [questions, idx, select],
  );

  const approve = useCallback(async () => {
    if (!question) return;
    const wasApproved = question.status === 'approved';
    const ok = wasApproved ? await flush() : await saveWith({ status: 'approved' });
    if (!ok) return;
    // next not-approved question after the current one (wrapping around)
    const after = [...questions.slice(idx + 1), ...questions.slice(0, idx)];
    const next = after.find((q) => q.status !== 'approved' && q.number !== question.number);
    if (next) setCurrent(next.number);
    else {
      toast.success('همه‌ی سؤال‌ها تأیید شدند.');
      if (wasApproved && questions[idx + 1]) setCurrent(questions[idx + 1].number);
    }
  }, [question, questions, idx, flush, saveWith, toast]);

  const unapprove = useCallback(async () => {
    await saveWith({ status: 'pending' });
  }, [saveWith]);

  // ----------------------------------------------------------- flags & words
  const focusField = useCallback((field: string, start?: number, end?: number) => {
    const el = fieldRefs.current.get(field);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (start !== undefined && end !== undefined) el.setSelectionRange(start, end);
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  const onFlagClick = useCallback(
    (flag: Flag, index: number) => {
      if (!question || !draft) return;
      setActiveFlag(index);
      const text = getFieldText(draft, flag.field);
      const mark = computeMarks(text, question.flags, flag.field).find((m) => m.flagIndex === index);
      focusField(flag.field, mark?.start, mark?.end);
      setFocus({ doc: flag.doc, page: flag.page, bbox: flag.bbox, nonce: ++focusNonce.current });
    },
    [question, draft, focusField],
  );

  const onWordClick = useCallback(
    (word: Word, line: Line, doc: DocKind, page: number) => {
      if (!question || !draft) return;
      // A flagged word of this question?
      const fi = question.flags.findIndex(
        (f) => f.doc === doc && f.page === page && f.bbox && word.bbox && f.bbox.every((v, i) => Math.abs(v - word.bbox![i]) < 0.002),
      );
      if (fi >= 0) {
        onFlagClick(question.flags[fi], fi);
        return;
      }
      const inRegion = question.regions.some(
        (r) => r.doc === doc && r.page === page && word.bbox &&
          (word.bbox[0] + word.bbox[2]) / 2 >= r.bbox[0] && (word.bbox[0] + word.bbox[2]) / 2 <= r.bbox[2] &&
          (word.bbox[1] + word.bbox[3]) / 2 >= r.bbox[1] && (word.bbox[1] + word.bbox[3]) / 2 <= r.bbox[3],
      );
      if (!inRegion) return;
      const needle = stripPunct(word.text);
      if (!needle) return;
      let candidates: string[];
      if (doc === 'explanations') candidates = ['explanation'];
      else {
        const lead = toAsciiDigits(line.words[0]?.text ?? '');
        const m = /^([1-4])[).]$/.exec(lead);
        candidates = m
          ? [`option:${m[1]}`, 'stem', 'option:1', 'option:2', 'option:3', 'option:4']
          : ['stem', 'option:1', 'option:2', 'option:3', 'option:4', 'explanation'];
      }
      for (const field of candidates) {
        const text = getFieldText(draft, field);
        const at = text.indexOf(needle);
        if (at >= 0) {
          focusField(field, at, at + needle.length);
          setTab('text');
          return;
        }
      }
      toast.info(`«${needle}» در متن سؤال پیدا نشد.`);
    },
    [question, draft, onFlagClick, focusField, toast],
  );

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void approve();
      } else if ((e.altKey && e.key === 'ArrowDown') || (e.key === 'PageDown' && !e.ctrlKey)) {
        e.preventDefault();
        goRel(1);
      } else if ((e.altKey && e.key === 'ArrowUp') || (e.key === 'PageUp' && !e.ctrlKey)) {
        e.preventDefault();
        goRel(-1);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void flush();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [approve, goRel, flush, dialog]);

  // ------------------------------------------------------------------ actions
  const doReocr = async (engine: EngineName) => {
    if (!question) return;
    setDialog(null);
    setBusy('reocr');
    try {
      const q = await api.reocr(id, question.number, engine);
      replaceQuestion(q);
      setVersion((v) => v + 1);
      toast.success(`سؤال ${fa(q.number)} بازخوانی شد.`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const doReparse = async (blueprint: string) => {
    setDialog(null);
    setBusy('reparse');
    try {
      const p = await api.reparse(id, blueprint);
      clearPageCache(id);
      setProject(p);
      setCurrent(null);
      setVersion((v) => v + 1);
      toast.success('تحلیل مجدد انجام شد.');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const doAdd = async (n: number) => {
    setDialog(null);
    await flush();
    try {
      const q = await api.addQuestion(id, n);
      const p = await load();
      if (!p) setProject((pp) => (pp ? { ...pp, questions: [...pp.questions, q] } : pp));
      setCurrent(q.number);
      setVersion((v) => v + 1);
      toast.success(`سؤال ${fa(q.number)} اضافه شد.`);
    } catch (err) {
      toast.error(err);
    }
  };

  const doDelete = async () => {
    if (!question) return;
    setDialog(null);
    const n = question.number;
    const next = questions[idx + 1] ?? questions[idx - 1] ?? null;
    try {
      await api.deleteQuestion(id, n);
      setProject((p) => (p ? { ...p, questions: p.questions.filter((q) => q.number !== n) } : p));
      setCurrent(next?.number ?? null);
      setVersion((v) => v + 1);
      toast.success(`سؤال ${fa(n)} حذف شد.`);
      void load();
    } catch (err) {
      toast.error(err);
    }
  };

  const [pushResult, setPushResult] = useState<{ ok: boolean; text: string } | null>(null);
  const doPush = async () => {
    await flush();
    setBusy('push');
    setPushResult(null);
    try {
      const r = await api.push(id, onlyApproved);
      setPushResult({ ok: r.ok, text: JSON.stringify(r.response, null, 2) });
      if (r.ok) toast.success('سؤال‌ها به سایت ارسال شد.');
      else toast.error('سایت درخواست را نپذیرفت.');
    } catch (err) {
      setPushResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  // ------------------------------------------------------------------ render
  if (loadError && !project) {
    return (
      <div className="page">
        <ReviewTopbar />
        <main className="container">
          <div className="card">
            <div className="alert alert-danger">{loadError}</div>
            <div className="row-gap">
              <button className="btn" onClick={load}>
                تلاش دوباره
              </button>
              <a className="btn btn-ghost" href="#/">
                بازگشت به پروژه‌ها
              </a>
            </div>
          </div>
        </main>
      </div>
    );
  }
  if (!project) {
    return (
      <div className="page">
        <ReviewTopbar />
        <div className="empty muted">در حال بارگذاری پروژه…</div>
      </div>
    );
  }

  if (project.status !== 'ready') {
    const pct = percent(project.progress.done, project.progress.total);
    return (
      <div className="page">
        <ReviewTopbar title={project.title} />
        <main className="container narrow">
          <div className="card processing-card" aria-live="polite">
            <h2 className="card-title">{project.title}</h2>
            <StatusChip status={project.status} stage={project.progress.stage} />
            {project.status === 'failed' ? (
              <>
                <div className="alert alert-danger">{project.error || 'پردازش ناموفق بود.'}</div>
                <a className="btn" href="#/">
                  بازگشت به پروژه‌ها
                </a>
              </>
            ) : (
              <>
                <ol className="stages">
                  {(['queued', 'rendering', 'ocr', 'parsing'] as const).map((s, i, all) => {
                    const curIdx = all.indexOf(project.progress.stage as (typeof all)[number]);
                    return (
                      <li key={s} className={cx('stage', i < curIdx && 'is-done', i === curIdx && 'is-current')}>
                        <span className="stage-dot">{i < curIdx ? <Icon name="check" size={14} /> : fa(i + 1)}</span>
                        {STAGE_LABELS[s]}
                      </li>
                    );
                  })}
                </ol>
                <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className={cx('bar-fill', !project.progress.total && 'is-indeterminate')} style={{ width: `${pct}%` }} />
                </div>
                <div className="muted small">
                  {STAGE_LABELS[project.progress.stage] ?? project.progress.stage}
                  {project.progress.total > 0 && (
                    <>
                      {' '}— {fa(project.progress.done)} از {fa(project.progress.total)} صفحه
                    </>
                  )}
                </div>
                <div className="muted small">موتور: {ENGINE_LABELS[project.engine] ?? project.engine}</div>
              </>
            )}
          </div>
        </main>
      </div>
    );
  }

  const approvedCount = questions.filter((q) => q.status === 'approved').length;
  const errorCount = questions.filter((q) => questionState(q) === 'error').length;
  const pushCount = onlyApproved ? approvedCount : questions.length;

  return (
    <div className="review">
      <header className="review-header">
        <a href="#/" className="btn btn-sm btn-ghost btn-icon" aria-label="بازگشت به پروژه‌ها" title="بازگشت">
          <Icon name="back" />
        </a>
        <div className="review-title">
          <h1 dir="auto">{project.title}</h1>
          <div className="small muted review-sub">
            {TRACK_LABELS[project.track]} {project.year ? fa(project.year) : ''} ·{' '}
            <span data-testid="count-total">{fa(questions.length)}</span> سؤال ·{' '}
            <span className="text-success" data-testid="count-approved">{fa(approvedCount)}</span> تأییدشده ·{' '}
            <span className={errorCount ? 'text-danger' : undefined}>{fa(errorCount)}</span> خطا
          </div>
        </div>
        <div className="review-actions">
          <button className="btn btn-sm" onClick={() => setDialog({ kind: 'reparse' })} disabled={busy === 'reparse'}>
            <Icon name="refresh" size={16} /> {busy === 'reparse' ? 'در حال تحلیل…' : 'تحلیل مجدد'}
          </button>
          <label className="toggle toggle-sm" title="خروجی و ارسال فقط شامل سؤال‌های تأییدشده باشد">
            <input type="checkbox" checked={onlyApproved} onChange={(e) => setOnlyApproved(e.target.checked)} />
            <span>فقط تأییدشده‌ها</span>
          </label>
          <a className="btn btn-sm" href={exportUrl(id, onlyApproved)} download={`dadrose-${id}.json`}>
            <Icon name="download" size={16} /> دانلود JSON
          </a>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              setPushResult(null);
              setDialog({ kind: 'push' });
            }}
          >
            <Icon name="send" size={16} /> ارسال به سایت
          </button>
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label="نما">
        {(
          [
            ['list', 'سؤال‌ها', 'list'],
            ['text', 'متن', 'text'],
            ['image', 'تصویر', 'image'],
          ] as const
        ).map(([key, label, icon]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={cx('tab', tab === key && 'is-on')} onClick={() => setTab(key)}>
            <Icon name={icon} size={16} /> {label}
          </button>
        ))}
      </div>

      <div className={`panes tab-${tab}`}>
        <div className="pane pane-nav">
          <Navigator
            questions={questions}
            current={current}
            onSelect={select}
            filter={filter}
            onFilter={setFilter}
            projectIssues={project.issues}
            onAdd={() => setDialog({ kind: 'add' })}
          />
        </div>
        <div className="pane pane-editor">
          {question && draft ? (
            <Editor
              question={question}
              draft={draft}
              saveState={saveState}
              activeFlagIndex={activeFlag}
              onChange={update}
              onOption={setOption}
              onBlurField={() => void flush()}
              onSave={() => void flush()}
              onApprove={() => void approve()}
              onUnapprove={() => void unapprove()}
              onReocr={() => setDialog({ kind: 'reocr' })}
              onDelete={() => setDialog({ kind: 'delete' })}
              onAdd={() => setDialog({ kind: 'add' })}
              onPrev={() => goRel(-1)}
              onNext={() => goRel(1)}
              hasPrev={idx > 0}
              hasNext={idx >= 0 && idx < questions.length - 1}
              onFlagClick={onFlagClick}
              register={register}
              index={idx}
              total={questions.length}
              reocrBusy={busy === 'reocr'}
              hasExplanations={hasExplanations}
            />
          ) : (
            <div className="empty muted">
              {questions.length === 0 ? (
                <>
                  سؤالی استخراج نشد.{' '}
                  <button className="link" onClick={() => setDialog({ kind: 'add' })}>
                    افزودن سؤال
                  </button>
                </>
              ) : (
                'یک سؤال را انتخاب کنید.'
              )}
            </div>
          )}
        </div>
        <div className="pane pane-viewer">
          <PageViewer
            projectId={id}
            documents={project.documents}
            question={question}
            activeFlagIndex={activeFlag}
            focus={focus}
            onWordClick={onWordClick}
          />
        </div>
      </div>

      {dialog?.kind === 'reocr' && question && (
        <ReocrDialog
          number={question.number}
          defaultEngine={(health?.default_engine as EngineName) || 'auto'}
          engineAvailable={engineAvailable}
          onCancel={() => setDialog(null)}
          onConfirm={doReocr}
        />
      )}
      {dialog?.kind === 'reparse' && (
        <ReparseDialog
          current={project.blueprint}
          blueprints={meta?.blueprints ?? []}
          editedCount={questions.filter((q) => q.edited || q.status === 'approved').length}
          onCancel={() => setDialog(null)}
          onConfirm={doReparse}
        />
      )}
      {dialog?.kind === 'add' && (
        <AddDialog questions={questions} onCancel={() => setDialog(null)} onConfirm={doAdd} />
      )}
      {dialog?.kind === 'delete' && question && (
        <Modal
          title={`حذف سؤال ${fa(question.number)}`}
          tone="danger"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="btn btn-danger" onClick={doDelete}>
                حذف
              </button>
              <button className="btn" onClick={() => setDialog(null)}>
                انصراف
              </button>
            </>
          }
        >
          <p>این سؤال از پروژه حذف می‌شود. ادامه می‌دهید؟</p>
        </Modal>
      )}
      {dialog?.kind === 'push' && (
        <Modal
          title="ارسال به سایت دادرس"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="btn btn-primary" onClick={doPush} disabled={busy === 'push' || pushCount === 0}>
                <Icon name="send" size={16} /> {busy === 'push' ? 'در حال ارسال…' : `ارسال ${fa(pushCount)} سؤال`}
              </button>
              <button className="btn" onClick={() => setDialog(null)}>
                بستن
              </button>
            </>
          }
        >
          <label className="toggle">
            <input type="checkbox" checked={onlyApproved} onChange={(e) => setOnlyApproved(e.target.checked)} />
            <span>فقط سؤال‌های تأییدشده ({fa(approvedCount)} از {fa(questions.length)})</span>
          </label>
          {!onlyApproved && errorCount > 0 && (
            <div className="alert alert-warning small">{fa(errorCount)} سؤال هنوز خطا دارد.</div>
          )}
          {pushResult && (
            <div className={cx('alert', pushResult.ok ? 'alert-success' : 'alert-danger')} data-testid="push-result">
              <div>{pushResult.ok ? 'ارسال موفق بود. پاسخ سایت:' : 'ارسال ناموفق بود:'}</div>
              <pre className="pre" dir="ltr">
                {pushResult.text}
              </pre>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function ReviewTopbar({ title }: { title?: string }) {
  return (
    <header className="topbar">
      <a href="#/" className="brand" aria-label="بازگشت به پروژه‌ها">
        <BrandMark />
        <div>
          <div className="brand-name">دادرس</div>
          <div className="brand-sub">{title ?? 'تبدیل دفترچه‌ی آزمون به سؤال'}</div>
        </div>
      </a>
    </header>
  );
}

function ReocrDialog({
  number, defaultEngine, engineAvailable, onCancel, onConfirm,
}: {
  number: number;
  defaultEngine: EngineName;
  engineAvailable: (e: EngineName) => boolean;
  onCancel: () => void;
  onConfirm: (e: EngineName) => void;
}) {
  const engines: EngineName[] = ['auto', 'claude', 'gemini', 'offline'];
  const [engine, setEngine] = useState<EngineName>(engineAvailable(defaultEngine) ? defaultEngine : 'auto');
  return (
    <Modal
      title={`بازخوانی سؤال ${fa(number)}`}
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn-primary" onClick={() => onConfirm(engine)}>
            <Icon name="sparkle" size={16} /> بازخوانی
          </button>
          <button className="btn" onClick={onCancel}>
            انصراف
          </button>
        </>
      }
    >
      <p>متن سؤال از روی ناحیه‌ی آن در تصویر دوباره خوانده می‌شود و <b>جایگزین متن فعلی و ویرایش‌های شما</b> می‌شود.</p>
      <label className="field">
        <span className="field-label">موتور</span>
        <select className="input" value={engine} onChange={(e) => setEngine(e.target.value as EngineName)}>
          {engines.map((e) => (
            <option key={e} value={e} disabled={!engineAvailable(e)}>
              {ENGINE_LABELS[e]} {engineAvailable(e) ? '' : '(پیکربندی نشده)'}
            </option>
          ))}
        </select>
      </label>
    </Modal>
  );
}

function ReparseDialog({
  current, blueprints, editedCount, onCancel, onConfirm,
}: {
  current: string;
  blueprints: { code: string; title: string; question_count: number }[];
  editedCount: number;
  onCancel: () => void;
  onConfirm: (bp: string) => void;
}) {
  const [bp, setBp] = useState(current || 'auto');
  return (
    <Modal
      title="تحلیل مجدد سؤال‌ها"
      tone="danger"
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn-danger" onClick={() => onConfirm(bp)}>
            تحلیل مجدد
          </button>
          <button className="btn" onClick={onCancel}>
            انصراف
          </button>
        </>
      }
    >
      <p>
        سؤال‌ها از روی متن OCR ذخیره‌شده دوباره استخراج می‌شوند.{' '}
        <b>همه‌ی ویرایش‌ها و تأییدها از بین می‌رود</b>
        {editedCount > 0 && <> ({fa(editedCount)} سؤال ویرایش یا تأیید شده)</>}.
      </p>
      <label className="field">
        <span className="field-label">الگوی آزمون</span>
        <select className="input" value={bp} onChange={(e) => setBp(e.target.value)}>
          <option value="auto">خودکار — تشخیص از روی عنوان درس‌ها</option>
          {blueprints.map((b) => (
            <option key={b.code} value={b.code}>
              {b.title} ({fa(b.question_count)} سؤال)
            </option>
          ))}
        </select>
      </label>
    </Modal>
  );
}

function AddDialog({
  questions, onCancel, onConfirm,
}: {
  questions: Question[];
  onCancel: () => void;
  onConfirm: (n: number) => void;
}) {
  const used = new Set(questions.map((q) => q.number));
  const max = Math.max(0, ...used);
  let firstGap = 1;
  while (used.has(firstGap)) firstGap++;
  const [value, setValue] = useState(String(firstGap <= max ? firstGap : max + 1));
  const n = Number(toAsciiDigits(value).trim());
  const invalid = !Number.isInteger(n) || n < 1;
  const taken = !invalid && used.has(n);
  return (
    <Modal
      title="افزودن سؤال"
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn-primary" onClick={() => onConfirm(n)} disabled={invalid || taken}>
            افزودن
          </button>
          <button className="btn" onClick={onCancel}>
            انصراف
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid && !taken) onConfirm(n);
        }}
      >
        <label className="field">
          <span className="field-label">شماره‌ی سؤال</span>
          <input
            className={cx('input', (invalid || taken) && 'is-invalid')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode="numeric"
            dir="ltr"
            data-autofocus
          />
          {taken && <span className="field-hint text-danger">این شماره قبلاً وجود دارد.</span>}
          {firstGap <= max && <span className="field-hint">شماره‌ی جاافتاده: {fa(firstGap)}</span>}
        </label>
      </form>
    </Modal>
  );
}
