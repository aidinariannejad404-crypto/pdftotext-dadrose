import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { pageImageUrl } from '../api';
import { usePageResult } from '../pageCache';
import type { BBox, DocInfo, DocKind, Flag, Line, Question, Word } from '../types';
import { AI_MODE_LABELS, DOC_LABELS, cx, fa, sameBox } from '../util';
import { Icon } from './Icons';

export interface FocusTarget {
  doc: DocKind;
  page: number;
  bbox: BBox | null;
  nonce: number;
}

interface Props {
  projectId: string;
  documents: DocInfo[];
  question: Question | null;
  flags: Flag[]; // current (draft) suspicious words of the question
  activeFlagIndex: number | null;
  hoverFlagIndex?: number | null;
  focus: FocusTarget | null; // scroll/switch request (question change, flag click)
  onWordClick: (word: Word, line: Line, doc: DocKind, page: number) => void;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

function boxStyle(b: readonly number[]) {
  return {
    left: `${b[0] * 100}%`,
    top: `${b[1] * 100}%`,
    width: `${(b[2] - b[0]) * 100}%`,
    height: `${(b[3] - b[1]) * 100}%`,
  };
}

interface Hover {
  word: Word;
  line: Line;
  flagged: Flag | null;
}

export default function PageViewer({
  projectId, documents, question, flags: allFlags, activeFlagIndex, hoverFlagIndex, focus, onWordClick,
}: Props) {
  const docs = documents.filter((d) => d.page_count > 0);
  const [doc, setDoc] = useState<DocKind>(docs[0]?.kind ?? 'booklet');
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1); // 1 = fit width
  const [orig, setOrig] = useState(false);
  const [showText, setShowText] = useState(false);
  const [hover, setHover] = useState<Hover | null>(null);
  const [hoverLine, setHoverLine] = useState<number | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [imgError, setImgError] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<BBox | null>(null);
  const zoomAnchor = useRef<{ fx: number; fy: number; px: number; py: number } | null>(null);

  const pageCount = docs.find((d) => d.kind === doc)?.page_count ?? 0;
  const src = pageImageUrl(projectId, doc, page, orig);
  const { data: pr, error: prError } = usePageResult(projectId, doc, page, pageCount > 0);
  const imgReady = loadedSrc === src;

  // Switch doc/page and scroll on focus requests.
  useEffect(() => {
    if (!focus) return;
    setDoc(focus.doc);
    setPage(focus.page);
    pendingScroll.current = focus.bbox;
    setHover(null);
  }, [focus]);

  const applyPendingScroll = useCallback(() => {
    const b = pendingScroll.current;
    const sc = scrollRef.current;
    const wrap = wrapRef.current;
    if (!b || !sc || !wrap || !wrap.offsetHeight) return;
    pendingScroll.current = null;
    const W = wrap.offsetWidth;
    const H = wrap.offsetHeight;
    const top = b[1] * H - 24;
    const bottom = b[3] * H + 24;
    // Only scroll if the box is not already fully visible.
    if (top < sc.scrollTop || bottom > sc.scrollTop + sc.clientHeight) {
      sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
    if (W > sc.clientWidth) {
      const left = b[0] * W - 24;
      const right = b[2] * W + 24;
      if (left < sc.scrollLeft || right > sc.scrollLeft + sc.clientWidth) {
        sc.scrollTo({ left: Math.max(0, right - sc.clientWidth), behavior: 'smooth' });
      }
    }
  }, []);

  useEffect(() => {
    if (imgReady) applyPendingScroll();
  }, [imgReady, focus, doc, page, applyPendingScroll]);

  // Ctrl/⌘ + wheel zoom around the pointer.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = sc.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      zoomAnchor.current = {
        fx: (sc.scrollLeft + px) / sc.scrollWidth,
        fy: (sc.scrollTop + py) / sc.scrollHeight,
        px,
        py,
      };
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => sc.removeEventListener('wheel', onWheel);
  }, []);

  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    const sc = scrollRef.current;
    if (!a || !sc) return;
    zoomAnchor.current = null;
    sc.scrollLeft = a.fx * sc.scrollWidth - a.px;
    sc.scrollTop = a.fy * sc.scrollHeight - a.py;
  }, [zoom]);

  const zoomBy = (f: number) => {
    const sc = scrollRef.current;
    if (sc) {
      zoomAnchor.current = {
        fx: (sc.scrollLeft + sc.clientWidth / 2) / sc.scrollWidth,
        fy: (sc.scrollTop + sc.clientHeight / 2) / sc.scrollHeight,
        px: sc.clientWidth / 2,
        py: sc.clientHeight / 2,
      };
    }
    setZoom((z) => clampZoom(z * f));
  };

  useEffect(() => {
    setImgError(false);
  }, [src]);

  const regions = useMemo(
    () => (question?.regions ?? []).filter((r) => r.doc === doc && r.page === page),
    [question, doc, page],
  );
  const flags = useMemo(
    () =>
      allFlags
        .map((f, i) => ({ f, i }))
        .filter(({ f }) => f.doc === doc && f.page === page && f.bbox),
    [allFlags, doc, page],
  );
  const flagForWord = (w: Word): Flag | null => flags.find(({ f }) => sameBox(f.bbox, w.bbox))?.f ?? null;

  const showOverlays = !orig;
  const hoverLineBox = hoverLine !== null ? pr?.lines[hoverLine]?.bbox ?? null : null;

  const goPage = (p: number) => {
    setPage(Math.max(0, Math.min(pageCount - 1, p)));
    setHover(null);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const hasRegionsElsewhere = (question?.regions ?? []).some((r) => !(r.doc === doc && r.page === page));

  return (
    <section className="viewer" aria-label="تصویر صفحه">
      <div className="viewer-toolbar">
        {docs.length > 1 && (
          <div className="segmented segmented-sm" role="radiogroup" aria-label="سند">
            {docs.map((d) => (
              <button
                key={d.kind}
                role="radio"
                aria-checked={doc === d.kind}
                className={cx('seg', doc === d.kind && 'is-on')}
                onClick={() => {
                  setDoc(d.kind);
                  setPage(0);
                  setHover(null);
                }}
              >
                {DOC_LABELS[d.kind]}
              </button>
            ))}
          </div>
        )}
        <div className="btn-group" role="group" aria-label="صفحه">
          <button className="btn btn-sm btn-icon" onClick={() => goPage(page - 1)} disabled={page <= 0} aria-label="صفحه‌ی قبل" title="صفحه‌ی قبل">
            <Icon name="chev-right" />
          </button>
          <span className="page-indicator" aria-live="polite">
            صفحه‌ی {fa(page + 1)} / {fa(pageCount || 1)}
          </span>
          <button
            className="btn btn-sm btn-icon"
            onClick={() => goPage(page + 1)}
            disabled={page >= pageCount - 1}
            aria-label="صفحه‌ی بعد"
            title="صفحه‌ی بعد"
          >
            <Icon name="chev-left" />
          </button>
        </div>
        {pr && (
          <span
            className={cx('read-badge', `read-${pr.ai_mode ?? 'none'}`)}
            title={`این صفحه ${pr.ai_mode === 'transcribe' ? 'به‌طور کامل با هوش مصنوعی بازنویسی شد' : pr.ai_mode === 'correct' ? 'آفلاین خوانده شد و خطوط مشکوکش با هوش مصنوعی اصلاح شد' : 'فقط آفلاین خوانده شد (بدون هزینه)'}${pr.quality != null ? ` — کیفیت خواندن آفلاین: ${fa(Math.round(pr.quality * 100))}٪` : ''}`}
            data-testid="read-badge"
          >
            {AI_MODE_LABELS[pr.ai_mode ?? 'none']}
            {pr.quality != null && <span className="read-q">{fa(Math.round(pr.quality * 100))}٪</span>}
          </span>
        )}
        <div className="btn-group" role="group" aria-label="بزرگ‌نمایی">
          <button className="btn btn-sm btn-icon" onClick={() => zoomBy(1 / 1.25)} aria-label="کوچک‌نمایی" title="کوچک‌نمایی (Ctrl + چرخ ماوس)" disabled={zoom <= ZOOM_MIN}>
            <Icon name="zoom-out" />
          </button>
          <button className="btn btn-sm zoom-label" onClick={() => setZoom(1)} title="هم‌عرض صفحه" aria-label="هم‌عرض صفحه">
            {zoom === 1 ? <Icon name="fit" /> : `${fa(Math.round(zoom * 100))}٪`}
          </button>
          <button className="btn btn-sm btn-icon" onClick={() => zoomBy(1.25)} aria-label="بزرگ‌نمایی" title="بزرگ‌نمایی (Ctrl + چرخ ماوس)" disabled={zoom >= ZOOM_MAX}>
            <Icon name="zoom-in" />
          </button>
        </div>
        <span className="spacer" />
        <label className="toggle" title="تصویر خام قبل از پیش‌پردازش؛ کادرها فقط روی تصویر پردازش‌شده دقیق‌اند">
          <input type="checkbox" checked={orig} onChange={(e) => setOrig(e.target.checked)} />
          <span>تصویر اصلی</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={showText} onChange={(e) => setShowText(e.target.checked)} data-testid="toggle-ocr-text" />
          <span>نمایش متن استخراج‌شده</span>
        </label>
      </div>

      <div className={cx('viewer-body', showText && 'with-text')}>
        <div className="viewer-scroll" ref={scrollRef} data-testid="viewer-scroll">
          {pageCount === 0 ? (
            <div className="empty muted">صفحه‌ای برای نمایش نیست.</div>
          ) : (
            <div className="page-wrap" ref={wrapRef} style={{ width: `${zoom * 100}%` }}>
              <img
                key={src}
                src={src}
                alt={`${DOC_LABELS[doc]} — صفحه‌ی ${fa(page + 1)}`}
                className={cx('page-img', !imgReady && 'is-loading')}
                onLoad={() => setLoadedSrc(src)}
                onError={() => setImgError(true)}
                draggable={false}
              />
              {imgError && <div className="img-error">بارگذاری تصویر صفحه ناموفق بود.</div>}
              {showOverlays && imgReady && (
                <div className="overlays" onMouseLeave={() => setHover(null)}>
                  {regions.map((r, i) => (
                    <div key={`r${i}`} className="ov-region" style={boxStyle(r.bbox)} />
                  ))}
                  {pr?.lines.map((line, li) =>
                    line.words.map((w, wi) =>
                      w.bbox ? (
                        <div
                          key={`w${li}-${wi}`}
                          className={cx('ov-word', w.flag && `ov-word-${w.flag}`, !w.flag && w.alt && 'ov-word-ai')}
                          style={boxStyle(w.bbox)}
                          onMouseEnter={() => setHover({ word: w, line, flagged: flagForWord(w) })}
                          onClick={() => onWordClick(w, line, doc, page)}
                          data-testid="ov-word"
                        />
                      ) : null,
                    ),
                  )}
                  {flags.map(({ f, i }) => (
                    <div
                      key={`f${i}`}
                      className={cx('ov-flag', `ov-flag-${f.reason}`, activeFlagIndex === i && 'is-active', hoverFlagIndex === i && 'is-hover')}
                      style={boxStyle(f.bbox!)}
                      data-testid="ov-flag"
                    />
                  ))}
                  {hoverLineBox && <div className="ov-line" style={boxStyle(hoverLineBox)} />}
                  {hover?.word.bbox && <WordTip hover={hover} />}
                </div>
              )}
            </div>
          )}
        </div>

        {showText && (
          <div className="ocr-text" aria-label="متن استخراج‌شده‌ی صفحه">
            {!pr && !prError && <div className="muted small">در حال دریافت متن…</div>}
            {prError && <div className="text-danger small">دریافت متن صفحه ناموفق بود.</div>}
            {pr && (
              <>
                <div className="ocr-meta small muted">
                  {pr.source === 'text_layer' ? 'لایه‌ی متنی PDF' : `OCR — ${pr.engine}`}
                  {pr.preprocess.length > 0 && <> · پیش‌پردازش: {pr.preprocess.join('، ')}</>}
                </div>
                {pr.warnings.map((w, i) => (
                  <div key={i} className="issue issue-warning small">
                    {w}
                  </div>
                ))}
                {pr.lines.map((line, li) => {
                  const inQuestion = regions.some(
                    (r) => line.bbox && line.bbox[1] >= r.bbox[1] - 0.005 && line.bbox[3] <= r.bbox[3] + 0.005,
                  );
                  return (
                    <p
                      key={li}
                      className={cx('ocr-line', inQuestion && 'in-question', hoverLine === li && 'is-hover')}
                      onMouseEnter={() => setHoverLine(li)}
                      onMouseLeave={() => setHoverLine(null)}
                      onClick={() => {
                        if (line.bbox) {
                          pendingScroll.current = line.bbox;
                          applyPendingScroll();
                        }
                      }}
                    >
                      {line.words.map((w, wi) => (
                        <span key={wi}>
                          {wi > 0 && ' '}
                          {w.flag ? (
                            <mark className={`hl-mark hl-${w.flag}`} title={w.alt ? `خوانش دیگر: ${w.alt}` : 'اطمینان پایین'}>
                              {w.text}
                            </mark>
                          ) : (
                            w.text
                          )}
                        </span>
                      ))}
                    </p>
                  );
                })}
                {pr.lines.length === 0 && <div className="muted small">متنی در این صفحه شناسایی نشد.</div>}
              </>
            )}
          </div>
        )}
      </div>
      {question && regions.length === 0 && hasRegionsElsewhere && !orig && (
        <div className="viewer-hint small">
          ناحیه‌ی سؤال {fa(question.number)} در صفحه‌ی دیگری است.{' '}
          <button
            className="link"
            onClick={() => {
              const r = question.regions[0];
              setDoc(r.doc);
              setPage(r.page);
              pendingScroll.current = r.bbox;
            }}
          >
            رفتن به ناحیه
          </button>
        </div>
      )}
      {orig && <div className="viewer-hint small">روی تصویر اصلی کادرها نمایش داده نمی‌شوند.</div>}
    </section>
  );
}

function clampZoom(z: number) {
  const v = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  return Math.abs(v - 1) < 0.04 ? 1 : Math.round(v * 100) / 100;
}

function WordTip({ hover }: { hover: Hover }) {
  const b = hover.word.bbox!;
  const below = b[1] < 0.12;
  const reason = hover.word.flag ?? hover.flagged?.reason ?? null;
  const alt = hover.word.alt ?? hover.flagged?.alt ?? null;
  const aiFixed = !reason && !!hover.word.alt; // alt without flag = corrected by AI
  const conf = hover.word.conf;
  return (
    <div
      className={cx('word-tip', below ? 'is-below' : 'is-above')}
      style={{
        left: `${Math.min(88, Math.max(12, ((b[0] + b[2]) / 2) * 100))}%`,
        top: below ? `${b[3] * 100}%` : `${b[1] * 100}%`,
      }}
      role="tooltip"
      data-testid="word-tip"
    >
      <div className="word-tip-text" dir="auto">
        {hover.word.text}
      </div>
      <div className="word-tip-meta">
        {conf !== null && conf !== undefined && (
          <span className={cx('conf', conf < 60 ? 'conf-low' : conf < 85 ? 'conf-mid' : 'conf-high')}>
            اطمینان {fa(Math.round(conf))}٪
          </span>
        )}
        {reason === 'disagree' && <span className="tag tag-warning">اختلاف موتورها</span>}
        {reason === 'low_conf' && <span className="tag tag-danger">اطمینان پایین</span>}
      </div>
      {aiFixed ? (
        <div className="word-tip-ai" data-testid="word-tip-ai">
          اصلاح هوش مصنوعی: <b dir="auto">{alt}</b> ← <b dir="auto">{hover.word.text}</b>
        </div>
      ) : (
        alt && (
          <div className="word-tip-alt">
            خوانش دیگر: <b dir="auto">{alt}</b>
          </div>
        )
      )}
    </div>
  );
}
