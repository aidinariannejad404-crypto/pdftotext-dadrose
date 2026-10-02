// Vite dev-server middleware that fakes the FastAPI backend (see docs/ARCHITECTURE.md).
// State is in-memory; POST /api/__mock/reset restores the seed (used by tests).
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import type { DocKind, Project, ProjectSummary, Question, QuestionUpdate, ReviewQueueItem } from '../src/types';
import { parseKeys } from '../src/util';
import {
  META, classifyQuestion, makeReadyProject, makeTextProject, notesPageText, pageResult, pageSvg, setFontData, validateQuestion, type PageSet,
} from './data';

interface MockProject extends Project {
  _startedAt?: number;
  _duration?: number; // ms until processing finishes
  _set?: PageSet; // which fake page layout the images/OCR come from
  _texts?: Record<string, string>; // text mode: edited page text, keyed "doc:page"
  _subject?: string; // default_subject from upload
}

const pageKey = (doc: string, page: number) => `${doc}:${page}`;

function origText(p: MockProject, doc: DocKind, page: number): string {
  if (p._set === 'notes') return notesPageText(page);
  const r = pageResult(doc, page, p._set);
  return r ? r.lines.map((l) => l.words.map((w) => w.text).join(' ')).join('\n') : '';
}

function pageText(p: MockProject, doc: DocKind, page: number) {
  const k = pageKey(doc, page);
  const edited = p._texts?.[k];
  return { text: edited ?? origText(p, doc, page), edited: edited !== undefined, approved: !!p.page_status?.[k] };
}

let projects: MockProject[] = [];
let pushConfigured = false;
const jobs = new Map<number, { started: number; total: number }>();
let jobSeq = 100;

function seed() {
  const now = Date.now();
  projects = [
    {
      ...makeReadyProject('p-processing', 'آزمون مرکز وکلا ۱۴۰۴ (در حال پردازش)', new Date(now - 60_000).toISOString()),
      track: 'center', year: 1404, status: 'processing', questions: [], issues: [],
      progress: { stage: 'ocr', done: 5, total: 14 },
      _startedAt: now - 10 * 60_000, _duration: 20 * 60_000, // stays in the OCR stage
    },
    withDemoExtras(makeReadyProject('demo', 'آزمون کانون وکلا ۱۴۰۳', new Date(now - 3600_000).toISOString())),
    {
      ...pendingAll(makeReadyProject('b-1', 'کتاب تست تجارت - فصل ۱', new Date(now - 1800_000).toISOString())),
      track: 'other', year: null, batch_id: 'batch-1',
    },
    {
      ...makeReadyProject('b-2', 'کتاب تست تجارت - فصل ۲', new Date(now - 1799_000).toISOString()),
      track: 'other', year: null, batch_id: 'batch-1', status: 'queued', questions: [], issues: [],
      progress: { stage: 'queued', done: 0, total: 0 },
    },
    {
      ...makeReadyProject('b-3', 'کتاب تست تجارت - فصل ۳', new Date(now - 1798_000).toISOString()),
      track: 'other', year: null, batch_id: 'batch-1', status: 'queued', questions: [], issues: [],
      progress: { stage: 'queued', done: 0, total: 0 },
    },
    { ...makeTextProject('notes', 'بانک نکات حقوق مدنی', new Date(now - 7200_000).toISOString()), _set: 'notes', _texts: {} },
    {
      ...makeReadyProject('p-failed', 'آزمون کانون ۱۴۰۱ — اسکن ناقص', new Date(now - 86400_000).toISOString()),
      year: 1401, status: 'failed', questions: [], issues: [],
      progress: { stage: 'failed', done: 2, total: 9 },
      error: 'فایل PDF خراب است یا رمز دارد.',
    },
  ];
}
seed();

function pendingAll<T extends Project>(p: T): T {
  p.questions.forEach((q) => {
    q.status = 'pending';
    q.approved_by = null;
  });
  return p;
}

function withDemoExtras(p: MockProject): MockProject {
  const q1 = p.questions.find((q) => q.number === 1);
  if (q1) q1.approved_by = 'admin';
  const q10 = p.questions.find((q) => q.number === 10);
  if (q10) q10.approved_by = 'auto';
  const q11 = p.questions.find((q) => q.number === 11);
  if (q11) {
    q11.duplicates = [{ project_id: 'b-1', project_title: 'کتاب تست تجارت - فصل ۱', number: 11, similarity: 0.97 }];
    q11.issues = [...q11.issues, { level: 'warning', code: 'duplicate', message: 'این سؤال تکراری به نظر می‌رسد.', field: null }];
  }
  return p;
}

function isClean(q: Question) {
  return q.status !== 'approved' && !q.issues.some((i) => i.level === 'error') && q.flags.length === 0 && !(q.duplicates ?? []).length;
}

function autoApprove(p: MockProject): number {
  let n = 0;
  for (const q of p.questions) {
    if (isClean(q)) {
      q.status = 'approved';
      q.approved_by = 'auto';
      n++;
    }
  }
  return n;
}

function advance(p: MockProject) {
  if (p.status !== 'queued' && p.status !== 'processing') return;
  if (!p._startedAt || !p._duration) return;
  const t = (Date.now() - p._startedAt) / p._duration;
  const total = 3;
  if (t < 0.12) {
    p.status = 'queued';
    p.progress = { stage: 'queued', done: 0, total: 0 };
  } else if (t < 0.3) {
    p.status = 'processing';
    p.progress = { stage: 'rendering', done: Math.floor(((t - 0.12) / 0.18) * total), total };
  } else if (t < 0.85) {
    p.status = 'processing';
    p.progress = { stage: 'ocr', done: Math.floor(((t - 0.3) / 0.55) * total), total };
  } else if (t < 1) {
    p.status = 'processing';
    p.progress = { stage: 'parsing', done: total, total };
  } else {
    const ready = p.doc_type === 'text' ? makeTextProject(p.id, p.title, p.created_at) : makeReadyProject(p.id, p.title, p.created_at);
    if (p.doc_type === 'text') {
      p._set = 'notes';
      p._texts = {};
      p.page_status = {};
      ready.page_status = {};
    }
    if (p._subject) ready.questions.forEach((q) => (q.subject_key = p._subject!));
    const wantAuto = p.auto_approve;
    pendingAll(ready);
    Object.assign(p, {
      ...ready, auto_approve: wantAuto, batch_id: p.batch_id, track: p.track, year: p.year, blueprint: p.blueprint, engine: p.engine,
      documents: p.doc_type === 'text' ? ready.documents : p.documents,
    });
    if (wantAuto && p.mode !== 'text') autoApprove(p);
  }
}

function queuedIds() {
  return projects
    .filter((x) => x.status === 'queued')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((x) => x.id);
}

function summary(p: MockProject): ProjectSummary {
  return {
    id: p.id, title: p.title, track: p.track, year: p.year, created_at: p.created_at, status: p.status,
    progress: p.progress, error: p.error,
    mode: p.mode ?? 'questions',
    batch_id: p.batch_id ?? null,
    queue_position: p.status === 'queued' ? queuedIds().indexOf(p.id) + 1 || null : null,
    auto_approved_count: p.questions.filter((q) => q.approved_by === 'auto' && q.status === 'approved').length,
    duplicate_count: p.questions.filter((q) => (q.duplicates ?? []).length > 0).length,
    stats: p.stats,
    page_count: p.documents.reduce((n, d) => n + d.page_count, 0),
    question_count: p.questions.length,
    // text mode: approved pages
    approved_count:
      p.mode === 'text'
        ? Object.values(p.page_status ?? {}).filter(Boolean).length
        : p.questions.filter((q) => q.status === 'approved').length,
    error_count: p.questions.filter((q) => q.issues.some((i) => i.level === 'error')).length,
  };
}

function strip(p: MockProject): Project {
  const { _startedAt, _duration, _set, _texts, _subject, ...rest } = p;
  void _subject;
  void _startedAt;
  void _duration;
  void _set;
  void _texts;
  return rest;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

const notFound = (res: ServerResponse, what = 'پروژه پیدا نشد.') => send(res, 404, { detail: what });

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function json<T>(req: IncomingMessage): Promise<T> {
  const buf = await readBody(req);
  return (buf.length ? JSON.parse(buf.toString('utf8')) : {}) as T;
}

function multipartField(body: string, name: string): string | null {
  const m = new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(body);
  return m ? m[1] : null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hasExpl(p: Project) {
  return p.documents.some((d) => d.kind === 'explanations');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://mock');
  const path = url.pathname;
  if (!path.startsWith('/api/')) return false;
  const method = req.method ?? 'GET';
  await delay(120); // feel a little like a network
  projects.forEach(advance);

  if (path === '/api/__mock/push-config' && method === 'POST') {
    pushConfigured = !!(await json<{ on: boolean }>(req)).on;
    return send(res, 200, { ok: true, push_configured: pushConfigured }), true;
  }
  if (path === '/api/site/check') {
    return (pushConfigured ? send(res, 200, { ok: true }) : send(res, 502, { detail: 'اتصال به سایت پیکربندی نشده است.' })), true;
  }
  const jm = /^\/api\/site\/import-jobs\/(\d+)$/.exec(path);
  if (jm) {
    const j = jobs.get(Number(jm[1]));
    if (!j) return notFound(res, 'کار پیدا نشد.'), true;
    const age = Date.now() - j.started;
    const status = age > 4000 ? 'needs_review' : age > 1500 ? 'parsing' : 'queued';
    return send(res, 200, { id: Number(jm[1]), status, total_items: j.total }), true;
  }
  if (path === '/api/__mock/reset' && method === 'POST') {
    pushConfigured = false;
    seed();
    return send(res, 200, { ok: true }), true;
  }
  if (path === '/api/health') {
    return send(res, 200, { ok: true, engines: { offline: true, claude: true, gemini: false }, default_engine: 'claude', push_configured: pushConfigured }), true;
  }
  if (path === '/api/meta') return send(res, 200, META), true;

  if (path === '/api/projects' && method === 'GET') {
    const list = [...projects].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(summary);
    return send(res, 200, list), true;
  }
  if (path === '/api/queue' && method === 'GET') {
    return send(res, 200, { running: projects.filter((x) => x.status === 'processing').map((x) => x.id), queued: queuedIds() }), true;
  }

  if (path === '/api/review-queue' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit')) || 200;
    const only = url.searchParams.get('project_id');
    const items: ReviewQueueItem[] = [];
    for (const pr of projects) {
      if (pr.status !== 'ready' || pr.mode === 'text' || (only && pr.id !== only)) continue;
      for (const q of pr.questions) {
        if (q.status === 'approved') continue;
        const level = q.issues.some((i) => i.level === 'error') ? 'error' : q.issues.some((i) => i.level === 'warning') || q.flags.length ? 'warning' : 'pending';
        items.push({ project_id: pr.id, project_title: pr.title, number: q.number, level, codes: [...new Set(q.issues.map((i) => i.code))], flags: q.flags.length });
      }
    }
    const rank = { error: 0, warning: 1, pending: 2 };
    items.sort((a, b) => rank[a.level] - rank[b.level]);
    return send(res, 200, items.slice(0, limit)), true;
  }

  if (path === '/api/push-approved' && method === 'POST') {
    if (!pushConfigured) return send(res, 502, { detail: 'اتصال به سایت پیکربندی نشده است.' }), true;
    const { project_ids } = await json<{ project_ids?: string[] }>(req);
    await delay(500);
    const list = projects.filter((x) => x.status === 'ready' && (!project_ids || project_ids.includes(x.id)));
    return send(res, 200, list.map((x) => {
      const n = x.questions.filter((q) => q.status === 'approved').length;
      return n ? { project_id: x.id, ok: true, questions: n, response: { id: ++jobSeq, status: 'queued', total_items: n } } : { project_id: x.id, ok: false, questions: 0, detail: 'سؤال تأییدشده‌ای ندارد.' };
    })), true;
  }

  if (path === '/api/projects/batch' && method === 'POST') {
    const body = (await readBody(req)).toString('utf8');
    const names = [...body.matchAll(/name="files"; filename="([^"]+)"/g)].map((m) => m[1]);
    if (!names.length) return send(res, 422, { detail: 'هیچ فایلی انتخاب نشده است.' }), true;
    const titles = [...body.matchAll(/name="titles"\r\n\r\n([\s\S]*?)\r\n--/g)].map((m) => m[1]);
    const batchId = `batch-${Math.random().toString(36).slice(2, 7)}`;
    const created: MockProject[] = names.map((name, i) => {
      const id = `p-${Math.random().toString(36).slice(2, 8)}`;
      const base = makeReadyProject(id, titles[i] || name.replace(/\.[^.]+$/, ''), new Date(Date.now() + i).toISOString());
      return {
        ...base,
        track: (multipartField(body, 'track') || 'other') as Project['track'],
        year: Number(multipartField(body, 'year')) || null,
        blueprint: multipartField(body, 'blueprint') || 'auto',
        doc_type: (multipartField(body, 'doc_type') || 'auto') as Project['doc_type'],
        _subject: multipartField(body, 'default_subject') || undefined,
        auto_approve: multipartField(body, 'auto_approve') === '1',
        batch_id: batchId,
        status: 'queued', progress: { stage: 'queued', done: 0, total: 0 }, questions: [], issues: [],
        documents: base.documents.slice(0, 1),
        _startedAt: Date.now() + i * 3000, _duration: 6000,
      };
    });
    projects.push(...created);
    return send(res, 200, { batch_id: batchId, projects: created.map(strip) }), true;
  }

  if (path === '/api/projects' && method === 'POST') {
    const body = (await readBody(req)).toString('utf8');
    if (!/name="booklet"; filename="/.test(body)) return send(res, 422, { detail: 'فایل دفترچه الزامی است.' }), true;
    const title = multipartField(body, 'title') || 'پروژه‌ی جدید';
    const track = (multipartField(body, 'track') || 'other') as Project['track'];
    const year = Number(multipartField(body, 'year')) || null;
    const id = `p-${Math.random().toString(36).slice(2, 8)}`;
    const base = makeReadyProject(id, title, new Date().toISOString());
    const p: MockProject = {
      ...base, track, year,
      blueprint: multipartField(body, 'blueprint') || 'auto',
      doc_type: (multipartField(body, 'doc_type') || 'auto') as Project['doc_type'],
      _subject: multipartField(body, 'default_subject') || undefined,
      auto_approve: multipartField(body, 'auto_approve') === '1',
      engine: (multipartField(body, 'engine') || 'auto') as Project['engine'],
      status: 'queued', progress: { stage: 'queued', done: 0, total: 0 }, questions: [], issues: [],
      documents: /name="explanations"; filename="[^"]+"/.test(body) ? base.documents : base.documents.slice(0, 1),
      _startedAt: Date.now(), _duration: 9000,
    };
    projects.push(p);
    return send(res, 200, strip(p)), true;
  }

  const m = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return notFound(res, 'مسیر پیدا نشد.'), true;
  const p = projects.find((x) => x.id === decodeURIComponent(m[1]));
  const rest = m[2] ?? '';
  if (!p) return notFound(res), true;

  if (rest === '' && method === 'GET') return send(res, 200, strip(p)), true;
  if (rest === '' && method === 'DELETE') {
    projects = projects.filter((x) => x !== p);
    return send(res, 200, { ok: true }), true;
  }

  const img = /^\/pages\/(booklet|explanations)\/(\d+)\.jpg$/.exec(rest);
  if (img && method === 'GET') {
    const svg = pageSvg(img[1] as DocKind, Number(img[2]), url.searchParams.get('variant') === 'orig', p._set);
    if (!svg) return notFound(res, 'صفحه پیدا نشد.'), true;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'max-age=60');
    res.end(svg);
    return true;
  }
  const pg = /^\/pages\/(booklet|explanations)\/(\d+)$/.exec(rest);
  if (pg && method === 'GET') {
    const r = pageResult(pg[1] as DocKind, Number(pg[2]), p._set);
    if (r) {
      const t = pageText(p, pg[1] as DocKind, Number(pg[2]));
      r.edited_text = t.edited ? t.text : null;
      r.approved = t.approved;
    }
    return (r ? send(res, 200, r) : notFound(res, 'صفحه پیدا نشد.')), true;
  }

  const pt = /^\/pages\/(booklet|explanations)\/(\d+)\/text$/.exec(rest);
  if (pt) {
    const doc = pt[1] as DocKind;
    const page = Number(pt[2]);
    const count = p.documents.find((d) => d.kind === doc)?.page_count ?? 0;
    if (page >= count) return notFound(res, 'صفحه پیدا نشد.'), true;
    if (method === 'PUT') {
      const upd = await json<{ text?: string | null; approved?: boolean }>(req);
      const k = pageKey(doc, page);
      p._texts = p._texts ?? {};
      p.page_status = p.page_status ?? {};
      if (upd.text === null) delete p._texts[k];
      else if (typeof upd.text === 'string') p._texts[k] = upd.text;
      if (typeof upd.approved === 'boolean') p.page_status[k] = upd.approved;
    }
    return send(res, 200, pageText(p, doc, page)), true;
  }

  if ((rest === '/export-text.docx' || rest === '/export.txt') && method === 'GET') {
    const only = url.searchParams.get('only_approved') === '1';
    const parts: string[] = [];
    for (const d of p.documents) {
      for (let i = 0; i < d.page_count; i++) {
        const t = pageText(p, d.kind, i);
        if (!only || t.approved) parts.push(t.text);
      }
    }
    const docx = rest.endsWith('.docx');
    res.statusCode = 200;
    res.setHeader(
      'Content-Type',
      docx ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain; charset=utf-8',
    );
    res.setHeader('Content-Disposition', `attachment; filename="dadrose-${p.id}-text.${docx ? 'docx' : 'txt'}"`);
    res.end(docx ? Buffer.from('PK\u0003\u0004 mock text docx') : parts.join('\n\n— — —\n\n'));
    return true;
  }

  if (rest === '/mode' && method === 'POST') {
    const { mode } = await json<{ mode: 'questions' | 'text' }>(req);
    if (mode !== 'questions' && mode !== 'text') return send(res, 422, { detail: 'حالت نامعتبر است.' }), true;
    await delay(400);
    p.mode = mode;
    p.page_status = p.page_status ?? {};
    p._texts = p._texts ?? {};
    if (mode === 'questions') {
      if (p._set === 'notes') {
        p.questions = [];
        p.issues = [{ level: 'error', code: 'no_questions', message: 'در این فایل سؤال تستی پیدا نشد.', field: null }];
      } else {
        const fresh = makeReadyProject(p.id, p.title, p.created_at);
        p.questions = fresh.questions;
        p.issues = fresh.issues;
      }
    }
    return send(res, 200, strip(p)), true;
  }

  if (rest === '/questions' && method === 'POST') {
    const { number } = await json<{ number: number }>(req);
    if (!Number.isInteger(number) || number < 1) return send(res, 422, { detail: 'شماره‌ی سؤال نامعتبر است.' }), true;
    if (p.questions.some((q) => q.number === number)) return send(res, 409, { detail: 'سؤالی با این شماره وجود دارد.' }), true;
    const q: Question = {
      number, subject_key: null, stem: '', options: ['1', '2', '3', '4'].map((key) => ({ key, text: '' })),
      correct_key: null, key_source: null, explanation: '', regions: [], flags: [], issues: [], status: 'pending', edited: true,
    };
    q.issues = validateQuestion(q, hasExpl(p));
    p.questions.push(q);
    p.questions.sort((a, b) => a.number - b.number);
    if (number === 8) p.issues = p.issues.filter((i) => i.code !== 'missing_numbers');
    return send(res, 200, q), true;
  }

  const qm = /^\/questions\/(\d+)(\/reocr)?$/.exec(rest);
  if (qm) {
    const q = p.questions.find((x) => x.number === Number(qm[1]));
    if (!q) return notFound(res, 'سؤال پیدا نشد.'), true;
    if (qm[2] && method === 'POST') {
      const { engine } = await json<{ engine: string }>(req);
      if (engine === 'gemini') return send(res, 400, { detail: 'موتور Gemini پیکربندی نشده است.' }), true;
      await delay(900);
      const fresh = makeReadyProject('x', '', '').questions.find((x) => x.number === q.number);
      if (fresh) Object.assign(q, { ...fresh, status: 'pending', edited: false, key_source: q.key_source, correct_key: q.correct_key });
      q.issues = validateQuestion(q, hasExpl(p));
      return send(res, 200, q), true;
    }
    if (method === 'PUT') {
      const upd = await json<QuestionUpdate>(req);
      if (upd.stem != null) q.stem = upd.stem;
      if (upd.options != null) q.options = upd.options;
      if (upd.explanation != null) q.explanation = upd.explanation;
      if (upd.source_ref != null) q.source_ref = upd.source_ref;
      const cls = (q.classification = q.classification ?? { subject_source: null, subject_confidence: null, topic_source: null, topic_confidence: null, section_path: [] });
      if (upd.topic != null && upd.topic !== (q.topic ?? '')) {
        q.topic = upd.topic;
        cls.topic_source = 'manual';
        cls.topic_confidence = 1;
      }
      if (upd.subject_key != null && upd.subject_key !== q.subject_key) {
        cls.subject_source = 'manual';
        cls.subject_confidence = 1;
      }
      if (upd.articles != null) q.articles = upd.articles;
      if (upd.subject_key !== undefined && upd.subject_key !== null) q.subject_key = upd.subject_key;
      if (upd.correct_key != null && upd.correct_key !== q.correct_key) {
        q.correct_key = upd.correct_key;
        q.key_source = 'manual';
      }
      if (upd.status != null) {
        q.status = upd.status;
        q.approved_by = upd.status === 'approved' ? 'admin' : null;
      }
      if (upd.flags != null) q.flags = upd.flags;
      if (upd.stem != null || upd.options != null || upd.explanation != null) q.edited = true;
      q.issues = validateQuestion(q, hasExpl(p));
      return send(res, 200, q), true;
    }
    if (method === 'DELETE') {
      p.questions = p.questions.filter((x) => x !== q);
      return send(res, 200, { ok: true }), true;
    }
  }

  if (rest === '/reparse' && method === 'POST') {
    const { blueprint } = await json<{ blueprint?: string }>(req);
    await delay(700);
    const fresh = makeReadyProject(p.id, p.title, p.created_at);
    p.questions = fresh.questions.map((q) => ({ ...q, status: 'pending' }));
    p.issues = fresh.issues;
    if (blueprint) p.blueprint = blueprint;
    return send(res, 200, strip(p)), true;
  }

  if (rest === '/export.json' && method === 'GET') {
    const only = url.searchParams.get('only_approved') === '1';
    const qs = p.questions.filter((q) => !only || q.status === 'approved');
    const payload = {
      source: { kind: 'official', track: p.track, year: p.year, title: p.title },
      questions: qs.map((q) => ({
        source_number: q.number, subject_key: q.subject_key, stem_html: `<p>${q.stem}</p>`,
        options: q.options.map((o, i) => ({ key: o.key, order: i + 1, text_html: o.text })),
        correct_key: q.correct_key, explanation_html: q.explanation ? `<p>${q.explanation}</p>` : '',
      })),
    };
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="dadrose-${p.id}.json"`);
    res.end(JSON.stringify(payload, null, 2));
    return true;
  }

  if (rest === '/export.docx' && method === 'GET') {
    // Dummy bytes standing in for the «ورود هوشمند از ورد» template document.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="dadrose-${p.id}.docx"`);
    res.end(Buffer.from('PK\u0003\u0004 mock docx — not a real Word file'));
    return true;
  }

  if (rest === '/push' && method === 'POST') {
    if (!pushConfigured) return send(res, 502, { detail: 'اتصال به سایت پیکربندی نشده است (DADROSE_API_URL / DADROSE_API_TOKEN).' }), true;
    const { only_approved } = await json<{ only_approved: boolean }>(req);
    await delay(500);
    const n = p.questions.filter((q) => !only_approved || q.status === 'approved').length;
    const id = ++jobSeq;
    jobs.set(id, { started: Date.now(), total: n });
    return send(res, 200, { ok: true, questions: n, response: { id, status: 'queued', total_items: n } }), true;
  }

  if (rest === '/auto-approve' && method === 'POST') {
    const n = autoApprove(p);
    return send(res, 200, { approved: n, project: strip(p) }), true;
  }

  if (rest === '/keys' && method === 'PUT') {
    const { keys, start } = await json<{ keys: string; start?: number }>(req);
    const parsed = parseKeys(keys ?? '');
    if (!parsed.some(Boolean)) return send(res, 422, { detail: 'هیچ کلیدی در متن واردشده پیدا نشد.' }), true;
    parsed.forEach((k, i) => {
      const q = p.questions.find((x) => x.number === (start ?? 1) + i);
      if (q && k) {
        q.correct_key = k;
        q.key_source = 'manual';
        q.issues = validateQuestion(q, hasExpl(p));
      }
    });
    return send(res, 200, strip(p)), true;
  }

  if (rest === '/classify' && method === 'POST') {
    const { engine, numbers } = await json<{ engine: string; numbers?: number[] }>(req);
    if (engine === 'gemini') return send(res, 400, { detail: 'موتور Gemini پیکربندی نشده است.' }), true;
    await delay(600);
    for (const q of p.questions) if (!numbers || numbers.includes(q.number)) classifyQuestion(q);
    return send(res, 200, strip(p)), true;
  }
  return send(res, 405, { detail: 'متد پشتیبانی نمی‌شود.' }), true;
}

export function mockApiPlugin(): Plugin {
  return {
    name: 'dadrose-mock-api',
    configureServer(server) {
      try {
        const fontPath = fileURLToPath(new URL('../src/fonts/Vazirmatn-Variable.woff2', import.meta.url));
        setFontData(readFileSync(fontPath).toString('base64'));
      } catch {
        // fall back to system fonts inside the SVG
      }
      server.middlewares.use((req, res, next) => {
        handle(req, res)
          .then((handled) => {
            if (!handled) next();
          })
          .catch((err: unknown) => send(res, 500, { detail: `خطای ماک: ${String(err)}` }));
      });
      server.config.logger.info('  ➜  Mock API enabled (/api/* served in-process)');
    },
  };
}
