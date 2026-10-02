import type {
  ClassifyEngine, DocKind, EngineName, Health, Meta, PageResult, PageText, PageTextUpdate, Project, ReviewMode, ProjectSummary, PushApprovedItem, PushResult, Question, QuestionUpdate, QueueState, ReviewQueueItem, SiteImportJob,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function detailToMessage(detail: unknown, status: number): string {
  if (typeof detail === 'string' && detail) return detail;
  if (Array.isArray(detail)) {
    // FastAPI validation errors: [{loc, msg, type}]
    return detail
      .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : String(d)))
      .join('؛ ');
  }
  return `خطای سرور (${status})`;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'ارتباط با سرور برقرار نشد');
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const detail = data && typeof data === 'object' && 'detail' in data ? (data as { detail: unknown }).detail : null;
    throw new ApiError(res.status, detailToMessage(detail, res.status));
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  health: () => request<Health>('GET', '/api/health'),
  meta: () => request<Meta>('GET', '/api/meta'),
  projects: () => request<ProjectSummary[]>('GET', '/api/projects'),
  project: (id: string) => request<Project>('GET', `/api/projects/${enc(id)}`),
  deleteProject: (id: string) => request<{ ok: boolean }>('DELETE', `/api/projects/${enc(id)}`),
  page: (id: string, doc: DocKind, page: number) =>
    request<PageResult>('GET', `/api/projects/${enc(id)}/pages/${doc}/${page}`),
  updateQuestion: (id: string, n: number, upd: QuestionUpdate) =>
    request<Question>('PUT', `/api/projects/${enc(id)}/questions/${n}`, upd),
  addQuestion: (id: string, number: number) => request<Question>('POST', `/api/projects/${enc(id)}/questions`, { number }),
  deleteQuestion: (id: string, n: number) => request<{ ok: boolean }>('DELETE', `/api/projects/${enc(id)}/questions/${n}`),
  reocr: (id: string, n: number, engine: EngineName) =>
    request<Question>('POST', `/api/projects/${enc(id)}/questions/${n}/reocr`, { engine }),
  reparse: (id: string, blueprint?: string) =>
    request<Project>('POST', `/api/projects/${enc(id)}/reparse`, blueprint ? { blueprint } : {}),
  pageText: (id: string, doc: DocKind, page: number) =>
    request<PageText>('GET', `/api/projects/${enc(id)}/pages/${doc}/${page}/text`),
  updatePageText: (id: string, doc: DocKind, page: number, upd: PageTextUpdate) =>
    request<PageText>('PUT', `/api/projects/${enc(id)}/pages/${doc}/${page}/text`, upd),
  classify: (id: string, engine: ClassifyEngine, numbers?: number[]) =>
    request<Project>('POST', `/api/projects/${enc(id)}/classify`, numbers ? { engine, numbers } : { engine }),
  setMode: (id: string, mode: ReviewMode) => request<Project>('POST', `/api/projects/${enc(id)}/mode`, { mode }),
  autoApprove: (id: string) => request<{ approved: number; project: Project }>('POST', `/api/projects/${enc(id)}/auto-approve`),
  reviewQueue: (projectId?: string, limit = 200) =>
    request<ReviewQueueItem[]>('GET', `/api/review-queue?limit=${limit}${projectId ? `&project_id=${enc(projectId)}` : ''}`),
  putKeys: (id: string, keys: string, start: number) => request<Project>('PUT', `/api/projects/${enc(id)}/keys`, { keys, start }),
  pushApproved: (projectIds?: string[]) =>
    request<PushApprovedItem[]>('POST', '/api/push-approved', projectIds ? { project_ids: projectIds } : {}),
  queue: () => request<QueueState>('GET', '/api/queue'),
  siteCheck: () => request<{ ok: boolean }>('GET', '/api/site/check'),
  importJob: (jobId: string | number) => request<SiteImportJob>('GET', `/api/site/import-jobs/${enc(String(jobId))}`),
  push: (id: string, onlyApproved: boolean) =>
    request<PushResult>('POST', `/api/projects/${enc(id)}/push`, { only_approved: onlyApproved }),
};

export function pageImageUrl(id: string, doc: DocKind, page: number, orig = false): string {
  return `/api/projects/${enc(id)}/pages/${doc}/${page}.jpg${orig ? '?variant=orig' : ''}`;
}

export function exportUrl(id: string, onlyApproved: boolean, format: 'json' | 'docx' = 'json'): string {
  return `/api/projects/${enc(id)}/export.${format}${onlyApproved ? '?only_approved=1' : ''}`;
}

/** One ZIP of Word files for several projects (text projects use the full-text docx). */
export function exportZipUrl(projectIds: string[], onlyApproved: boolean): string {
  return `/api/export.zip?project_ids=${projectIds.map(enc).join(',')}&only_approved=${onlyApproved ? 1 : 0}`;
}

/** Whole-document text export (text mode): Word or plain text. */
export function exportTextUrl(id: string, onlyApproved: boolean, format: 'docx' | 'txt'): string {
  const path = format === 'docx' ? 'export-text.docx' : 'export.txt';
  return `/api/projects/${enc(id)}/${path}${onlyApproved ? '?only_approved=1' : ''}`;
}

/** Multipart upload with progress (XHR, since fetch has no upload progress). */
export function createProject(form: FormData, onProgress?: (fraction: number) => void): Promise<Project> {
  return upload<Project>('/api/projects', form, onProgress);
}

/** Batch upload: every file becomes its own project. */
export function createBatch(
  form: FormData,
  onProgress?: (fraction: number) => void,
): Promise<{ batch_id: string; projects: Project[] }> {
  return upload('/api/projects/batch', form, onProgress);
}

function upload<T>(url: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'text';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'ارتباط با سرور برقرار نشد'));
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else {
        const detail = data && typeof data === 'object' && 'detail' in data ? (data as { detail: unknown }).detail : null;
        reject(new ApiError(xhr.status, detailToMessage(detail, xhr.status)));
      }
    };
    xhr.send(form);
  });
}
