import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, exportUrl } from '../api';
import { useAppData } from '../appData';
import { clearPageCache } from '../pageCache';
import type { DocKind, EngineName, Flag, Line, Project, Question, Word } from '../types';
import { useDraft, type Draft } from '../useDraft';
import {
  ENGINE_LABELS, STAGE_LABELS, computeMarks, cx, etaText, fa, getFieldText, isTypingTarget, percent,
  questionState, setFieldText, toAsciiDigits,
} from '../util';
import Editor, { NextProblemButton, type NextProblem } from './Editor';
import HelpDialog from './HelpDialog';
import { BrandMark, Icon } from './Icons';
import Menu from './Menu';
import ModeDialog from './ModeDialog';
import TextReview from './TextReview';
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
  | { kind: 'help' }
  | { kind: 'mode' }
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

const IMPORT_STEPS = [
  'فایل Word را دانلود کنید.',
  'در پنل مدیریت سایت دادرس، بخش «ورود هوشمند از ورد» را باز کنید و فایل را بارگذاری کنید.',
  'سؤال‌های تکراری و پیش‌نمایش را بررسی کنید و «ثبت نهایی» را بزنید.',
];

export default function ReviewPage({ id }: { id: string }) {
  const toast = useToast();
  const { meta, health, engineAvailable } = useAppData();
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [current, setCurrent] = useState<number | null>(readQueryNumber);
  const [version, setVersion] = useState(0); // bump when the current question is replaced externally
  const [filter, setFilter] = useState<NavFilter>('all');
  const [activeFlag, setActiveFlag] = useState<number | null>(null);
  const [hoverFlag, setHoverFlag] = useState<number | null>(null);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const [tab, setTab] = useState<MobileTab>('text');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [onlyApproved, setOnlyApproved] = useState(true);
  const [doneDismissed, setDoneDismissed] = useState(false);
  const [pushResult, setPushResult] = useState<{ ok: boolean; text: string } | null>(null);
  const fieldRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const editorPane = useRef<HTMLDivElement>(null);
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

  const retryRef = useRef<() => void>(() => {});
  const onSaveError = useCallback(
    (err: unknown) => toast.error(err, { label: 'تلاش دوباره', onClick: () => retryRef.current() }),
    [toast],
  );
  const draftApi = useDraft(id, question, `${question?.number ?? 'none'}:${version}`, replaceQuestion, onSaveError);
  const { draft, state: saveState, update, setOption, flush, saveWith } = draftApi;
  retryRef.current = () => void saveWith({});

  const register = useCallback((field: string, el: HTMLTextAreaElement | null) => {
    if (el) fieldRefs.current.set(field, el);
    else fieldRefs.current.delete(field);
  }, []);

  // Switch the viewer to the question's first region when the question changes.
  useEffect(() => {
    if (!question) return;
    writeQueryNumber(id, question.number);
    setActiveFlag(null);
    setHoverFlag(null);
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

  // Next question needing attention: errors first, then warnings, then anything not approved.
  const counts = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    let pending = 0;
    for (const q of questions) {
      const s = questionState(q);
      if (s === 'error') errors++;
      else if (s === 'warning') warnings++;
      if (s !== 'approved') pending++;
    }
    return { errors, warnings, pending, approved: questions.length - pending };
  }, [questions]);

  const findNextProblem = useCallback((): Question | null => {
    const after = [...questions.slice(idx + 1), ...questions.slice(0, Math.max(idx, 0))].filter(
      (q) => q.number !== current,
    );
    return (
      after.find((q) => questionState(q) === 'error') ??
      after.find((q) => questionState(q) === 'warning') ??
      after.find((q) => q.status !== 'approved') ??
      null
    );
  }, [questions, idx, current]);

  const goNextProblem = useCallback(() => {
    const q = findNextProblem();
    if (q) void select(q.number);
    else toast.info('سؤال دیگری برای بررسی نمانده است.');
  }, [findNextProblem, select, toast]);

  const nextProblem: NextProblem = useMemo(() => {
    const others = (s: string) => questions.filter((q) => q.number !== current && questionState(q) === s).length;
    const e = others('error');
    const w = others('warning');
    const p = questions.filter((q) => q.number !== current && q.status !== 'approved').length;
    if (e) return { label: 'خطای بعدی', count: e, disabled: false, tone: 'error', onClick: goNextProblem };
    if (w) return { label: 'مورد بعدی برای بررسی', count: w, disabled: false, tone: 'warning', onClick: goNextProblem };
    if (p) return { label: 'تأییدنشده‌ی بعدی', count: p, disabled: false, tone: 'neutral', onClick: goNextProblem };
    return { label: 'مورد دیگری نمانده', count: 0, disabled: true, tone: 'done', onClick: goNextProblem };
  }, [questions, current, goNextProblem]);

  const approve = useCallback(async () => {
    if (!question) return;
    const wasApproved = question.status === 'approved';
    const ok = wasApproved ? await flush() : await saveWith({ status: 'approved' });
    if (!ok) return;
    const after = [...questions.slice(idx + 1), ...questions.slice(0, idx)];
    const next = after.find((q) => q.status !== 'approved' && q.number !== question.number);
    if (next) setCurrent(next.number);
    else if (!wasApproved) {
      setDoneDismissed(false);
      toast.success('همه‌ی سؤال‌ها تأیید شدند.');
    } else if (questions[idx + 1]) setCurrent(questions[idx + 1].number);
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

  const onIssueClick = useCallback(
    (target: string | null) => {
      if (!target) return;
      setTab('text');
      if (fieldRefs.current.has(target)) {
        focusField(target);
        return;
      }
      const root = editorPane.current;
      let el: HTMLElement | null = null;
      if (target === 'key') {
        el = root?.querySelector<HTMLElement>('[data-key-radio]:checked') ?? root?.querySelector<HTMLElement>('[data-key-radio]') ?? null;
      } else {
        el = root?.querySelector<HTMLElement>(`[data-field="${target}"]`) ?? null;
      }
      if (el) {
        el.focus({ preventScroll: true });
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const box = target === 'key' ? el.closest<HTMLElement>('fieldset') : el;
        box?.classList.remove('flash');
        void box?.offsetWidth;
        box?.classList.add('flash');
      }
    },
    [focusField],
  );

  const onFlagClick = useCallback(
    (flag: Flag, index: number) => {
      if (!draft) return;
      setActiveFlag(index);
      const text = getFieldText(draft, flag.field);
      const mark = computeMarks(text, draft.flags, flag.field).find((m) => m.flagIndex === index);
      focusField(flag.field, mark?.start, mark?.end);
      setFocus({ doc: flag.doc, page: flag.page, bbox: flag.bbox, nonce: ++focusNonce.current });
    },
    [draft, focusField],
  );

  const resolveFlag = useCallback(
    (index: number, useAlt: boolean) => {
      if (!draft) return;
      const flag = draft.flags[index];
      if (!flag) return;
      const patch: Partial<Draft> = { flags: draft.flags.filter((_, i) => i !== index) };
      if (useAlt && flag.alt) {
        const text = getFieldText(draft, flag.field);
        const mark = computeMarks(text, draft.flags, flag.field).find((m) => m.flagIndex === index);
        if (mark) {
          Object.assign(patch, setFieldText(draft, flag.field, text.slice(0, mark.start) + flag.alt + text.slice(mark.end)));
        } else {
          toast.info(`«${flag.word}» در متن پیدا نشد؛ فقط از فهرست حذف شد.`);
        }
      }
      setActiveFlag(null);
      setHoverFlag(null);
      update(patch, true);
    },
    [draft, update, toast],
  );

  const onWordClick = useCallback(
    (word: Word, line: Line, doc: DocKind, page: number) => {
      if (!question || !draft) return;
      const fi = draft.flags.findIndex(
        (f) => f.doc === doc && f.page === page && f.bbox && word.bbox && f.bbox.every((v, i) => Math.abs(v - word.bbox![i]) < 0.002),
      );
      if (fi >= 0) {
        setTab('text');
        onFlagClick(draft.flags[fi], fi);
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
          setTab('text');
          focusField(field, at, at + needle.length);
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
      } else if (e.key === 'F8' || (e.altKey && e.code === 'KeyN')) {
        e.preventDefault();
        goNextProblem();
      } else if ((e.altKey && e.key === 'ArrowDown') || (e.key === 'PageDown' && !e.ctrlKey)) {
        e.preventDefault();
        goRel(1);
      } else if ((e.altKey && e.key === 'ArrowUp') || (e.key === 'PageUp' && !e.ctrlKey)) {
        e.preventDefault();
        goRel(-1);
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
        e.preventDefault();
        void flush();
      } else if ((e.key === '?' || e.key === '؟') && !isTypingTarget(e.target)) {
        e.preventDefault();
        setDialog({ kind: 'help' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [approve, goRel, goNextProblem, flush, dialog]);

  // ------------------------------------------------------------------ actions
  const doReocr = async (engine: EngineName) => {
    if (!question) return;
    setDialog(null);
    setBusy('reocr');
    try {
      const q = await api.reocr(id, question.number, engine);
      replaceQuestion(q);
      setVersion((v) => v + 1);
      toast.success(`سؤال ${fa(q.number)} دوباره خوانده شد.`);
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
      toast.success('سؤال‌ها دوباره استخراج شدند.');
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
      toast.success(`سؤال ${fa(q.number)} اضافه شد؛ متن آن را از روی تصویر وارد کنید.`);
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
                بازگشت به فهرست پروژه‌ها
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

  if (project.status !== 'ready') return <ProcessingView project={project} />;
  if (project.mode === 'text') return <TextReview project={project} setProject={setProject} />;

  const total = questions.length;
  const approvedCount = counts.approved;
  const allApproved = total > 0 && approvedCount === total;
  const exportCount = onlyApproved ? approvedCount : total;
  const pushConfigured = health?.push_configured === true;
  const wordUrl = exportUrl(id, onlyApproved, 'docx');
  const wordFile = `dadrose-${id}.docx`;
  const pct = percent(approvedCount, total);

  const wordButton = (big = false) =>
    exportCount === 0 ? (
      <button
        className={cx('btn btn-word', big ? 'btn-lg' : 'btn-sm')}
        disabled
        title="هنوز سؤالی تأیید نشده؛ گزینه‌ی «فقط تأییدشده‌ها» را بردارید یا ابتدا سؤال‌ها را تأیید کنید."
        data-testid="download-word"
      >
        <Icon name="download" size={big ? 20 : 16} /> دانلود فایل Word
      </button>
    ) : (
      <a
        className={cx('btn btn-word', big ? 'btn-lg' : 'btn-sm')}
        href={wordUrl}
        download={wordFile}
        title="فایل Word در قالب رسمی «ورود هوشمند از ورد» سایت"
        data-testid="download-word"
      >
        <Icon name="download" size={big ? 20 : 16} /> دانلود فایل Word <span className="btn-count">{fa(exportCount)} سؤال</span>
      </a>
    );

  const completion =
    allApproved && !doneDismissed ? (
      <div className="done-card" role="status" data-testid="done-card">
        <div className="done-head">
          <span className="done-icon">
            <Icon name="check" size={26} />
          </span>
          <div>
            <h3>همه‌ی سؤال‌ها تأیید شد</h3>
            <p className="muted">{fa(total)} سؤال آماده‌ی ورود به سایت است.</p>
          </div>
        </div>
        {wordButton(true)}
        <ol className="done-steps">
          {IMPORT_STEPS.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
        <button className="btn btn-sm btn-ghost" onClick={() => setDoneDismissed(true)}>
          بستن و ادامه‌ی ویرایش
        </button>
      </div>
    ) : null;

  return (
    <div className="review">
      <header className="review-header">
        <a href="#/" className="btn btn-sm btn-ghost btn-icon" aria-label="بازگشت به فهرست پروژه‌ها" title="بازگشت به فهرست پروژه‌ها">
          <Icon name="back" />
        </a>
        <div className="review-title">
          <h1 dir="auto">{project.title}</h1>
          <div className="review-progress">
            <div className="bar bar-sm" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="پیشرفت تأیید">
              <div className="bar-fill bar-success" style={{ width: `${pct}%` }} />
            </div>
            <span className="small">
              <b data-testid="count-approved">{fa(approvedCount)}</b> از <span data-testid="count-total">{fa(total)}</span> سؤال تأیید شد
              {counts.errors > 0 && <span className="text-danger"> · {fa(counts.errors)} خطا</span>}
            </span>
          </div>
        </div>
        <button
          className="btn btn-sm btn-ghost btn-icon show-mobile"
          onClick={() => setDialog({ kind: 'help' })}
          title="راهنما"
          aria-label="راهنما"
        >
          <span className="help-q" aria-hidden="true">؟</span>
        </button>
        <div className="review-actions">
          <label className="toggle toggle-sm" title="فایل خروجی فقط شامل سؤال‌های تأییدشده باشد">
            <input type="checkbox" checked={onlyApproved} onChange={(e) => setOnlyApproved(e.target.checked)} />
            <span>فقط تأییدشده‌ها</span>
          </label>
          {wordButton()}
          <Menu
            label="بیشتر"
            items={[
              {
                label: 'دانلود JSON',
                hint: 'برای برنامه‌نویس‌ها',
                icon: 'file',
                href: exportUrl(id, onlyApproved, 'json'),
                download: `dadrose-${id}.json`,
                disabled: exportCount === 0,
                testId: 'menu-json',
              },
              {
                label: 'ارسال مستقیم به سایت',
                hint: pushConfigured ? `${fa(exportCount)} سؤال` : 'پیکربندی نشده — از فایل Word استفاده کنید',
                icon: 'send',
                disabled: !pushConfigured,
                onSelect: () => {
                  setPushResult(null);
                  setDialog({ kind: 'push' });
                },
                testId: 'menu-push',
              },
              'sep',
              {
                label: 'نمایش به‌صورت متن کامل',
                hint: 'برای بانک نکات، جزوه یا کتاب',
                icon: 'text',
                onSelect: () => setDialog({ kind: 'mode' }),
                testId: 'menu-mode',
              },
              {
                label: busy === 'reparse' ? 'در حال استخراج…' : 'استخراج دوباره‌ی سؤال‌ها',
                hint: 'ویرایش‌ها و تأییدها پاک می‌شود',
                icon: 'refresh',
                danger: true,
                disabled: busy === 'reparse',
                onSelect: () => setDialog({ kind: 'reparse' }),
                testId: 'menu-reparse',
              },
            ]}
          />
          <button className="btn btn-sm btn-ghost hide-mobile" onClick={() => setDialog({ kind: 'help' })} title="راهنما (کلید ?)" data-testid="help">
            <span className="help-q" aria-hidden="true">؟</span> راهنما
          </button>
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label="نما">
        {(
          [
            ['list', 'فهرست سؤال‌ها', 'list'],
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
        <div className="pane pane-editor" ref={editorPane}>
          {question && draft ? (
            <Editor
              question={question}
              draft={draft}
              saveState={saveState}
              activeFlagIndex={activeFlag}
              onChange={update}
              onOption={setOption}
              onBlurField={() => void flush()}
              onSave={() => void saveWith({})}
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
              onFlagHover={setHoverFlag}
              onResolveFlag={resolveFlag}
              onIssueClick={onIssueClick}
              register={register}
              index={idx}
              total={questions.length}
              reocrBusy={busy === 'reocr'}
              hasExplanations={hasExplanations}
              nextProblem={nextProblem}
              banner={completion}
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
            flags={draft?.flags ?? question?.flags ?? []}
            activeFlagIndex={activeFlag}
            hoverFlagIndex={hoverFlag}
            focus={focus}
            onWordClick={onWordClick}
          />
        </div>
      </div>

      {/* Mobile: primary actions always reachable */}
      <div className="mobile-bar">
        <button className="btn btn-success" onClick={() => void approve()} disabled={!question} data-testid="mobile-approve">
          <Icon name="check" /> {question?.status === 'approved' ? 'بعدی' : 'تأیید و بعدی'}
        </button>
        <NextProblemButton np={nextProblem} />
        {allApproved && wordButton()}
      </div>

      {dialog?.kind === 'help' && <HelpDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'mode' && (
        <ModeDialog
          projectId={id}
          target="text"
          onClose={() => setDialog(null)}
          onDone={(p) => {
            setProject(p);
            setCurrent(null);
          }}
        />
      )}
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
      {dialog?.kind === 'add' && <AddDialog questions={questions} onCancel={() => setDialog(null)} onConfirm={doAdd} />}
      {dialog?.kind === 'delete' && question && (
        <Modal
          title={`حذف سؤال ${fa(question.number)}`}
          tone="danger"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="btn btn-danger" onClick={doDelete} data-testid="confirm-delete">
                بله، حذف شود
              </button>
              <button className="btn" onClick={() => setDialog(null)}>
                انصراف
              </button>
            </>
          }
        >
          <p>
            سؤال {fa(question.number)} از این پروژه حذف می‌شود و در فایل خروجی نخواهد بود. این کار قابل بازگشت نیست. فقط
            وقتی حذف کنید که سؤال تکراری یا اشتباه استخراج شده باشد.
          </p>
        </Modal>
      )}
      {dialog?.kind === 'push' && (
        <Modal
          title="ارسال مستقیم به سایت"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="btn btn-primary" onClick={doPush} disabled={busy === 'push' || exportCount === 0}>
                <Icon name="send" size={16} /> {busy === 'push' ? 'در حال ارسال…' : `ارسال ${fa(exportCount)} سؤال`}
              </button>
              <button className="btn" onClick={() => setDialog(null)}>
                بستن
              </button>
            </>
          }
        >
          <p className="muted small">روش پیشنهادی، دانلود فایل Word و بارگذاری آن در «ورود هوشمند از ورد» است.</p>
          <label className="toggle">
            <input type="checkbox" checked={onlyApproved} onChange={(e) => setOnlyApproved(e.target.checked)} />
            <span>
              فقط سؤال‌های تأییدشده ({fa(approvedCount)} از {fa(total)})
            </span>
          </label>
          {!onlyApproved && counts.errors > 0 && (
            <div className="alert alert-warning small">{fa(counts.errors)} سؤال هنوز خطا دارد.</div>
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

function ProcessingView({ project }: { project: Project }) {
  const { done, total, stage } = project.progress;
  const docPages = project.documents.reduce((s, d) => s + d.page_count, 0);
  const pages = total || docPages;
  const remaining = Math.max(0, pages - (stage === 'ocr' ? done : stage === 'parsing' ? pages : 0));
  const pct = percent(done, total);
  const stages = ['queued', 'rendering', 'ocr', 'parsing'] as const;
  const curIdx = stages.indexOf(stage as (typeof stages)[number]);
  const failed = project.status === 'failed';
  const STAGE_HELP: Record<string, string> = {
    queued: 'فایل در نوبت پردازش است و به‌زودی شروع می‌شود.',
    rendering: 'صفحه‌های PDF به تصویر تبدیل می‌شوند و کج‌بودن و سایه‌ی اسکن اصلاح می‌شود.',
    ocr: 'متن هر صفحه خوانده می‌شود. این طولانی‌ترین مرحله است.',
    parsing: 'سؤال‌ها، گزینه‌ها، کلید و پاسخ‌های تشریحی از متن جدا می‌شوند.',
  };

  return (
    <div className="page">
      <ReviewTopbar title={project.title} />
      <main className="container narrow">
        <div className="card processing-card" aria-live="polite">
          <div className="processing-head">
            <h2 className="card-title">{project.title}</h2>
            <StatusChip status={project.status} stage={stage} />
          </div>
          {failed ? (
            <>
              <div className="alert alert-danger">{project.error || 'پردازش ناموفق بود.'}</div>
              <p className="muted">
                اگر فایل رمز دارد یا خراب است، نسخه‌ی دیگری از آن را بارگذاری کنید. برای اسکن‌های موبایل، عکس واضح و
                بدون سایه نتیجه‌ی بهتری می‌دهد.
              </p>
              <a className="btn btn-primary" href="#/">
                بازگشت به فهرست پروژه‌ها
              </a>
            </>
          ) : (
            <>
              <p>
                فایل شما در حال پردازش است. پس از پایان، این صفحه خودکار به صفحه‌ی بازبینی تبدیل می‌شود.
              </p>
              <ol className="stages">
                {stages.map((s, i) => (
                  <li key={s} className={cx('stage', i < curIdx && 'is-done', i === curIdx && 'is-current')}>
                    <span className="stage-dot">{i < curIdx ? <Icon name="check" size={14} /> : fa(i + 1)}</span>
                    {STAGE_LABELS[s]}
                  </li>
                ))}
              </ol>
              <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div className={cx('bar-fill', !total && 'is-indeterminate')} style={{ width: `${pct}%` }} />
              </div>
              <div className="processing-stats">
                {total > 0 && (
                  <span>
                    صفحه‌ی <b>{fa(Math.min(done + (stage === 'ocr' ? 1 : 0), total))}</b> از <b>{fa(total)}</b>
                  </span>
                )}
                {pages > 0 && <span>زمان باقی‌مانده: {etaText(remaining)} (هر صفحه حدود ۵ تا ۱۵ ثانیه)</span>}
              </div>
              <p className="muted small">{STAGE_HELP[stage] ?? ''}</p>
              <div className="processing-foot">
                <a className="btn" href="#/">
                  <Icon name="back" size={16} /> بازگشت به فهرست (پردازش ادامه دارد)
                </a>
                <span className="muted small">موتور خواندن متن: {ENGINE_LABELS[project.engine] ?? project.engine}</span>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function ReviewTopbar({ title }: { title?: string }) {
  return (
    <header className="topbar">
      <a href="#/" className="brand" aria-label="بازگشت به فهرست پروژه‌ها">
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
      title={`بازخوانی سؤال ${fa(number)} با هوش مصنوعی`}
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
      <p>
        وقتی متن این سؤال خیلی به‌هم ریخته است، می‌توانید آن را دوباره از روی تصویر بخوانید.{' '}
        <b>متن فعلی و ویرایش‌های شما در این سؤال جایگزین می‌شود.</b>
      </p>
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
      title="استخراج دوباره‌ی سؤال‌ها"
      tone="danger"
      onClose={onCancel}
      footer={
        <>
          <button className="btn btn-danger" onClick={() => onConfirm(bp)} data-testid="confirm-reparse">
            استخراج دوباره
          </button>
          <button className="btn" onClick={onCancel}>
            انصراف
          </button>
        </>
      }
    >
      <p>
        سؤال‌ها از روی متنی که قبلاً از فایل خوانده شده، دوباره جدا می‌شوند (فایل دوباره خوانده نمی‌شود). مناسب وقتی است
        که الگوی آزمون اشتباه بوده یا سؤال‌ها به‌هم ریخته‌اند.
      </p>
      <div className="alert alert-danger small">
        همه‌ی ویرایش‌ها و تأییدهای شما پاک می‌شود
        {editedCount > 0 && <> ({fa(editedCount)} سؤال ویرایش یا تأیید شده)</>}.
      </div>
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
      <p className="muted small">برای سؤالی که استخراج نشده، یک سؤال خالی بسازید و متن آن را از روی تصویر وارد کنید.</p>
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
