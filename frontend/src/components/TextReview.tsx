import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, exportTextUrl, pageImageUrl } from '../api';
import { loadPage, usePageResult } from '../pageCache';
import type { DocKind, Flag, Line, PageResult, PageText, Project, Word } from '../types';
import type { SaveState } from '../useDraft';
import { DOC_LABELS, computeMarks, cx, fa, isTypingTarget, percent } from '../util';
import { SaveIndicator } from './Editor';
import HelpDialog from './HelpDialog';
import HighlightField from './HighlightField';
import { Icon } from './Icons';
import Menu from './Menu';
import Modal from './Modal';
import ModeDialog from './ModeDialog';
import PageViewer, { type FocusTarget } from './PageViewer';
import { useToast } from './Toasts';

interface PageRef {
  doc: DocKind;
  page: number;
  key: string; // "doc:page" (same as Project.page_status)
}

type Tab = 'list' | 'text' | 'image';
type Dialog = 'help' | 'revert' | 'mode' | null;

const stripPunct = (s: string) => s.replace(/^[.،؛:؟!«»()"'\-–—]+|[.،؛:؟!«»()"'\-–—]+$/g, '');

/** Suspicious words of a page (from OCR Word.flag/alt), as Flags for HighlightField/PageViewer. */
export function flagsFromPage(pr: PageResult | null, doc: DocKind): Flag[] {
  if (!pr) return [];
  const out: Flag[] = [];
  for (const line of pr.lines) {
    for (const w of line.words) {
      if (!w.flag) continue;
      const word = stripPunct(w.text);
      if (word) out.push({ field: 'text', word, doc, page: pr.index, bbox: w.bbox, reason: w.flag, alt: w.alt });
    }
  }
  return out;
}

function readPageParam(): string | null {
  const m = /[?&]pg=([a-z]+:\d+)/.exec(window.location.hash);
  return m ? m[1] : null;
}

const IMPORT_STEPS = [
  'فایل Word را دانلود کنید.',
  'آن را در Word باز کنید و در صورت نیاز قالب‌بندی (عنوان‌ها، فهرست‌ها) را تنظیم کنید.',
  'برای قرار دادن در سایت، متن را در بخش مربوط در پنل مدیریت سایت وارد کنید.',
];

export default function TextReview({ project, setProject }: { project: Project; setProject: (p: Project) => void }) {
  const toast = useToast();
  const id = project.id;
  const pages: PageRef[] = useMemo(
    () =>
      project.documents.flatMap((d) =>
        Array.from({ length: d.page_count }, (_, i) => ({ doc: d.kind, page: i, key: `${d.kind}:${i}` })),
      ),
    [project.documents],
  );
  const status = project.page_status ?? {};
  const approvedCount = pages.filter((p) => status[p.key]).length;
  const total = pages.length;
  const allApproved = total > 0 && approvedCount === total;
  const multiDoc = project.documents.filter((d) => d.page_count > 0).length > 1;

  const [cur, setCur] = useState<string>(() => {
    const fromUrl = readPageParam();
    if (fromUrl && pages.some((p) => p.key === fromUrl)) return fromUrl;
    return (pages.find((p) => !status[p.key]) ?? pages[0])?.key ?? 'booklet:0';
  });
  const idx = Math.max(0, pages.findIndex((p) => p.key === cur));
  const page = pages[idx];

  const [texts, setTexts] = useState<Record<string, PageText>>({});
  const [text, setText] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [tab, setTab] = useState<Tab>('text');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [onlyApproved, setOnlyApproved] = useState(false);
  const [activeFlag, setActiveFlag] = useState<number | null>(null);
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const [doneDismissed, setDoneDismissed] = useState(false);
  const [searching, setSearching] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const textRef = useRef<string | null>(null);
  const keyRef = useRef(cur);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<boolean> | null>(null);
  const focusNonce = useRef(0);
  const projectRef = useRef(project);
  projectRef.current = project;

  const { data: pr } = usePageResult(id, page?.doc ?? 'booklet', page?.page ?? 0, !!page);
  const flags = useMemo(() => (page ? flagsFromPage(pr, page.doc) : []), [pr, page]);

  useEffect(() => {
    document.title = `دادرس — ${project.title}`;
  }, [project.title]);

  // ----------------------------------------------------------- load page text
  useEffect(() => {
    if (!page) return;
    keyRef.current = page.key;
    history.replaceState(null, '', `#/p/${encodeURIComponent(id)}?pg=${page.key}`);
    setActiveFlag(null);
    setFocus({ doc: page.doc, page: page.page, bbox: null, nonce: ++focusNonce.current });
    const hit = texts[page.key];
    if (hit) {
      textRef.current = hit.text;
      setText(hit.text);
      return;
    }
    textRef.current = null;
    setText(null);
    let alive = true;
    api.pageText(id, page.doc, page.page).then(
      (t) => {
        if (!alive) return;
        setTexts((m) => ({ ...m, [page.key]: t }));
        if (keyRef.current === page.key) {
          textRef.current = t.text;
          setText(t.text);
        }
      },
      (err: unknown) => alive && toast.error(err),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.key, id]);

  // ------------------------------------------------------------------ saving
  const save = useCallback(
    async (extra?: { approved?: boolean; text?: null }): Promise<boolean> => {
      if (timer.current) clearTimeout(timer.current);
      if (inflight.current) await inflight.current;
      const key = keyRef.current;
      const ref = pages.find((p) => p.key === key);
      if (!ref) return false;
      const sendText = extra?.text === null ? null : dirty.current ? textRef.current : undefined;
      if (sendText === undefined && !extra) return true;
      const sentValue = textRef.current;
      setSaveState('saving');
      const run = (async () => {
        try {
          const body: { text?: string | null; approved?: boolean } = {};
          if (sendText !== undefined) body.text = sendText;
          if (extra?.approved !== undefined) body.approved = extra.approved;
          const t = await api.updatePageText(id, ref.doc, ref.page, body);
          setTexts((m) => ({ ...m, [key]: t }));
          if (keyRef.current === key) {
            if (textRef.current === sentValue || sendText === null) {
              dirty.current = false;
              setSaveState('saved');
            } else setSaveState('dirty');
            if (sendText === null) {
              textRef.current = t.text;
              setText(t.text);
            }
          }
          const p = projectRef.current;
          if ((p.page_status ?? {})[key] !== t.approved) {
            setProject({ ...p, page_status: { ...(p.page_status ?? {}), [key]: t.approved } });
          }
          return true;
        } catch (err) {
          if (keyRef.current === key) setSaveState('error');
          toast.error(err, { label: 'تلاش دوباره', onClick: () => void save({}) });
          return false;
        } finally {
          inflight.current = null;
        }
      })();
      inflight.current = run;
      return run;
    },
    [id, pages, setProject, toast],
  );

  const onChange = (v: string) => {
    textRef.current = v;
    dirty.current = true;
    setText(v);
    setSaveState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 800);
  };

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  // -------------------------------------------------------------- navigation
  const go = useCallback(
    async (key: string) => {
      if (key === keyRef.current) return;
      await save();
      dirty.current = false;
      setSaveState('saved');
      setCur(key);
      setTab((t) => (t === 'list' ? 'text' : t));
    },
    [save],
  );
  const goRel = (d: number) => {
    const p = pages[idx + d];
    if (p) void go(p.key);
  };

  const approve = useCallback(async () => {
    if (!page) return;
    const was = !!status[page.key];
    const ok = was ? await save() : await save({ approved: true });
    if (!ok) return;
    const after = [...pages.slice(idx + 1), ...pages.slice(0, idx)];
    const next = after.find((p) => !(projectRef.current.page_status ?? {})[p.key] && p.key !== page.key);
    if (next) void go(next.key);
    else if (!was) {
      setDoneDismissed(false);
      toast.success('همه‌ی صفحه‌ها تأیید شدند.');
    } else if (pages[idx + 1]) void go(pages[idx + 1].key);
  }, [page, status, save, pages, idx, go, toast]);

  const nextSuspicious = useCallback(async () => {
    setSearching(true);
    try {
      const after = [...pages.slice(idx + 1), ...pages.slice(0, idx)];
      const st = projectRef.current.page_status ?? {};
      for (const p of after) {
        if (st[p.key]) continue;
        try {
          const r = await loadPage(id, p.doc, p.page);
          if (r.lines.some((l) => l.words.some((w) => w.flag))) {
            void go(p.key);
            return;
          }
        } catch {
          /* skip unreadable pages */
        }
      }
      const unapproved = after.find((p) => !st[p.key]);
      if (unapproved) {
        toast.info('صفحه‌ی دیگری با کلمه‌ی مشکوک نیست؛ رفتن به صفحه‌ی تأییدنشده‌ی بعدی.');
        void go(unapproved.key);
      } else toast.info('صفحه‌ی دیگری برای بررسی نمانده است.');
    } finally {
      setSearching(false);
    }
  }, [pages, idx, id, go, toast]);

  // ---------------------------------------------------------- flags & words
  const selectFlag = (flag: Flag, index: number) => {
    setActiveFlag(index);
    const t = textRef.current ?? '';
    const m = computeMarks(t, flags, 'text').find((x) => x.flagIndex === index);
    const el = taRef.current;
    if (el && m) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(m.start, m.end);
    }
    setFocus({ doc: flag.doc, page: flag.page, bbox: flag.bbox, nonce: ++focusNonce.current });
  };

  const onWordClick = (word: Word, _line: Line, doc: DocKind, pg: number) => {
    if (!page || doc !== page.doc || pg !== page.page) return;
    const fi = flags.findIndex((f) => f.bbox && word.bbox && f.bbox.every((v, i) => Math.abs(v - word.bbox![i]) < 0.002));
    if (fi >= 0) {
      setTab('text');
      selectFlag(flags[fi], fi);
      return;
    }
    const needle = stripPunct(word.text);
    const t = textRef.current ?? '';
    const at = needle ? t.indexOf(needle) : -1;
    if (at >= 0 && taRef.current) {
      setTab('text');
      taRef.current.focus({ preventScroll: true });
      taRef.current.setSelectionRange(at, at + needle.length);
    } else if (needle) toast.info(`«${needle}» در متن این صفحه پیدا نشد.`);
  };

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void approve();
      } else if (e.key === 'F8' || (e.altKey && e.code === 'KeyN')) {
        e.preventDefault();
        void nextSuspicious();
      } else if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        goRel(1);
      } else if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        goRel(-1);
      } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
        e.preventDefault();
        void save();
      } else if ((e.key === '?' || e.key === '؟') && !isTypingTarget(e.target)) {
        e.preventDefault();
        setDialog('help');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ------------------------------------------------------------------ render
  const pct = percent(approvedCount, total);
  const pt = page ? texts[page.key] : undefined;
  const approved = page ? !!status[page.key] : false;
  const exportCount = onlyApproved ? approvedCount : total;
  const pageLabel = (p: PageRef) => `${multiDoc ? `${DOC_LABELS[p.doc]} — ` : ''}صفحه‌ی ${fa(p.page + 1)}`;

  const wordButton = (big = false) =>
    exportCount === 0 ? (
      <button className={cx('btn btn-word', big ? 'btn-lg' : 'btn-sm')} disabled title="هنوز صفحه‌ای تأیید نشده" data-testid="download-word">
        <Icon name="download" size={big ? 20 : 16} /> دانلود فایل Word
      </button>
    ) : (
      <a
        className={cx('btn btn-word', big ? 'btn-lg' : 'btn-sm')}
        href={exportTextUrl(id, onlyApproved, 'docx')}
        download={`dadrose-${id}.docx`}
        title="متن کامل، صفحه به صفحه، در یک فایل Word"
        data-testid="download-word"
      >
        <Icon name="download" size={big ? 20 : 16} /> دانلود فایل Word <span className="btn-count">{fa(exportCount)} صفحه</span>
      </a>
    );

  const nextSuspiciousBtn = (cls?: string) => (
    <button
      className={cx('btn btn-next-problem np-warning', cls)}
      onClick={() => void nextSuspicious()}
      disabled={searching || allApproved}
      title="صفحه‌ی تأییدنشده‌ی بعدی که کلمه‌ی مشکوک دارد (F8 یا Alt+N)"
      data-testid="next-suspicious"
    >
      <Icon name="alert" size={16} /> {searching ? 'در حال جست‌وجو…' : 'صفحه‌ی مشکوک بعدی'}
    </button>
  );

  return (
    <div className="review review-text">
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
              <b data-testid="pages-approved">{fa(approvedCount)}</b> از {fa(total)} صفحه تأیید شد · متن کامل
            </span>
          </div>
        </div>
        <button className="btn btn-sm btn-ghost btn-icon show-mobile" onClick={() => setDialog('help')} title="راهنما" aria-label="راهنما">
          <span className="help-q" aria-hidden="true">؟</span>
        </button>
        <div className="review-actions">
          <label className="toggle toggle-sm" title="فایل خروجی فقط شامل صفحه‌های تأییدشده باشد">
            <input type="checkbox" checked={onlyApproved} onChange={(e) => setOnlyApproved(e.target.checked)} />
            <span>فقط تأییدشده‌ها</span>
          </label>
          {wordButton()}
          <Menu
            label="بیشتر"
            items={[
              {
                label: 'دانلود متن ساده (TXT)',
                icon: 'file',
                href: exportTextUrl(id, onlyApproved, 'txt'),
                download: `dadrose-${id}.txt`,
                disabled: exportCount === 0,
                testId: 'menu-txt',
              },
              'sep',
              {
                label: 'تبدیل به حالت سؤال',
                hint: 'برای دفترچه‌ی آزمون یا کتاب تست',
                icon: 'list',
                onSelect: () => setDialog('mode'),
                testId: 'menu-mode',
              },
            ]}
          />
          <button className="btn btn-sm btn-ghost hide-mobile" onClick={() => setDialog('help')} title="راهنما (کلید ?)" data-testid="help">
            <span className="help-q" aria-hidden="true">؟</span> راهنما
          </button>
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label="نما">
        {(
          [
            ['list', 'صفحه‌ها', 'list'],
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
          <nav className="navigator" aria-label="فهرست صفحه‌ها">
            <div className="nav-progress">
              <div className="nav-progress-head">
                <span>صفحه‌های تأییدشده</span>
                <span className="nav-progress-num">
                  {fa(approvedCount)} / {fa(total)}
                </span>
              </div>
              <div className="bar" aria-hidden="true">
                <div className="bar-fill bar-success" style={{ width: `${pct}%` }} />
              </div>
            </div>
            <ol className="page-grid">
              {pages.map((p) => (
                <li key={p.key}>
                  <button
                    className={cx('page-thumb', status[p.key] && 'is-approved', p.key === cur && 'is-current')}
                    onClick={() => void go(p.key)}
                    aria-current={p.key === cur ? 'true' : undefined}
                    aria-label={`${pageLabel(p)}${status[p.key] ? ' — تأییدشده' : ''}`}
                    data-testid={`page-${p.key}`}
                    data-approved={status[p.key] ? 'true' : 'false'}
                  >
                    <img src={pageImageUrl(id, p.doc, p.page)} alt="" loading="lazy" />
                    <span className="page-thumb-label">
                      {status[p.key] && <Icon name="check" size={13} />} {multiDoc && p.doc === 'explanations' ? 'پ ' : ''}
                      {fa(p.page + 1)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="nav-legend small muted" aria-hidden="true">
              <span><i className="dot dot-approved" /> تأییدشده</span>
              <span><i className="dot dot-neutral" /> تأییدنشده</span>
            </div>
          </nav>
        </div>

        <div className="pane pane-editor">
          <section className="editor" aria-label="ویرایش متن صفحه">
            <div className="editor-head">
              <div className="editor-title">
                <div className="btn-group" role="group" aria-label="جابه‌جایی بین صفحه‌ها">
                  <button className="btn btn-sm btn-icon" onClick={() => goRel(-1)} disabled={idx <= 0} title="صفحه‌ی قبل (Alt+↑)" aria-label="صفحه‌ی قبل">
                    <Icon name="chev-right" />
                  </button>
                  <h2 className="qnum" data-testid="current-page">
                    {page ? pageLabel(page) : ''}
                  </h2>
                  <button className="btn btn-sm btn-icon" onClick={() => goRel(1)} disabled={idx >= total - 1} title="صفحه‌ی بعد (Alt+↓)" aria-label="صفحه‌ی بعد">
                    <Icon name="chev-left" />
                  </button>
                </div>
                <span className="muted small">
                  ({fa(idx + 1)} از {fa(total)})
                </span>
                {approved && (
                  <span className="chip chip-approved">
                    <Icon name="check" size={14} /> تأییدشده
                  </span>
                )}
                {pt?.edited && <span className="chip chip-neutral">ویرایش‌شده</span>}
              </div>
              <div className="editor-head-tools">
                <SaveIndicator state={saveState} onRetry={() => void save({})} />
                {nextSuspiciousBtn('btn-sm hide-mobile')}
              </div>
            </div>

            <div className="editor-scroll">
              {allApproved && !doneDismissed && (
                <div className="done-card" role="status" data-testid="done-card">
                  <div className="done-head">
                    <span className="done-icon">
                      <Icon name="check" size={26} />
                    </span>
                    <div>
                      <h3>همه‌ی صفحه‌ها تأیید شد</h3>
                      <p className="muted">متن کامل {fa(total)} صفحه آماده‌ی دانلود است.</p>
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
              )}

              {flags.length > 0 && text !== null && (
                <div className="text-flags" data-testid="text-flags">
                  <span className="small muted">کلمات مشکوک این صفحه (برای دیدن روی تصویر بزنید):</span>
                  {flags.map((f, i) => (
                    <button
                      key={i}
                      className={cx('flag-pill', `flag-${f.reason}`, activeFlag === i && 'is-active')}
                      onClick={() => selectFlag(f, i)}
                      title={f.alt ? `خوانش دیگر: ${f.alt}` : 'در تصویر خوانا نبود'}
                    >
                      {f.word}
                      {f.alt && <span className="flag-alt"> / {f.alt}</span>}
                    </button>
                  ))}
                </div>
              )}

              <div className="field-block text-editor">
                <label className="field-label" htmlFor="page-text">
                  متن صفحه — با تصویر مقایسه و اصلاح کنید
                </label>
                {text === null ? (
                  <div className="empty muted">در حال بارگذاری متن صفحه…</div>
                ) : (
                  <HighlightField
                    id="page-text"
                    field="text"
                    label="متن صفحه"
                    value={text}
                    flags={flags}
                    onChange={onChange}
                    onBlur={() => void save()}
                    register={(_f, el) => (taRef.current = el)}
                    activeFlagIndex={activeFlag}
                    onMarkClick={(m) => selectFlag(m.flag, m.flagIndex)}
                    placeholder="متنی در این صفحه شناسایی نشد؛ در صورت نیاز از روی تصویر تایپ کنید."
                  />
                )}
              </div>
            </div>

            <div className="editor-actions">
              <button className="btn btn-success btn-approve" onClick={() => void approve()} title="Ctrl+Enter" data-testid="approve-page">
                <Icon name="check" /> {approved ? 'صفحه‌ی بعد' : 'تأیید و صفحه‌ی بعد'} <kbd>Ctrl+↵</kbd>
              </button>
              {approved && (
                <button className="btn btn-sm btn-ghost" onClick={() => void save({ approved: false })}>
                  لغو تأیید
                </button>
              )}
              {saveState !== 'saved' && (
                <button className="btn" onClick={() => void save({})} disabled={saveState === 'saving'}>
                  <Icon name="save" /> ذخیره
                </button>
              )}
              <span className="spacer" />
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => setDialog('revert')}
                disabled={!pt?.edited && saveState === 'saved'}
                title="کنار گذاشتن ویرایش‌های این صفحه و بازگشت به متن خوانده‌شده"
                data-testid="revert-text"
              >
                <Icon name="refresh" size={16} /> بازگردانی متن اصلی
              </button>
            </div>
          </section>
        </div>

        <div className="pane pane-viewer">
          <PageViewer
            projectId={id}
            documents={project.documents}
            question={null}
            flags={flags}
            activeFlagIndex={activeFlag}
            focus={focus}
            onWordClick={onWordClick}
          />
        </div>
      </div>

      <div className="mobile-bar">
        <button className="btn btn-success" onClick={() => void approve()} data-testid="mobile-approve">
          <Icon name="check" /> {approved ? 'صفحه‌ی بعد' : 'تأیید و بعدی'}
        </button>
        {nextSuspiciousBtn()}
        {allApproved && wordButton()}
      </div>

      {dialog === 'help' && <HelpDialog mode="text" onClose={() => setDialog(null)} />}
      {dialog === 'mode' && (
        <ModeDialog projectId={id} target="questions" onClose={() => setDialog(null)} onDone={setProject} />
      )}
      {dialog === 'revert' && page && (
        <Modal
          title="بازگردانی متن اصلی"
          tone="danger"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button
                className="btn btn-danger"
                data-testid="confirm-revert"
                onClick={() => {
                  setDialog(null);
                  void save({ text: null });
                }}
              >
                بازگردانی
              </button>
              <button className="btn" onClick={() => setDialog(null)}>
                انصراف
              </button>
            </>
          }
        >
          <p>همه‌ی ویرایش‌های {pageLabel(page)} کنار گذاشته می‌شود و متنی که از تصویر خوانده شده بود برمی‌گردد.</p>
        </Modal>
      )}
    </div>
  );
}
