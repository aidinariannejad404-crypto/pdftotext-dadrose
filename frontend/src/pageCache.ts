import { useEffect, useState } from 'react';
import { api } from './api';
import type { DocKind, PageResult } from './types';

// OCR results per page, fetched lazily and cached for the session.
const cache = new Map<string, PageResult>();
const pending = new Map<string, Promise<PageResult>>();

const keyOf = (id: string, doc: DocKind, page: number) => `${id}/${doc}/${page}`;

export function loadPage(id: string, doc: DocKind, page: number): Promise<PageResult> {
  const key = keyOf(id, doc, page);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(key);
  if (!p) {
    p = api.page(id, doc, page).then(
      (r) => {
        cache.set(key, r);
        pending.delete(key);
        return r;
      },
      (err: unknown) => {
        pending.delete(key);
        throw err;
      },
    );
    pending.set(key, p);
  }
  return p;
}

export function clearPageCache(id: string) {
  for (const k of [...cache.keys()]) if (k.startsWith(`${id}/`)) cache.delete(k);
}

export function usePageResult(id: string, doc: DocKind, page: number, enabled = true) {
  const key = keyOf(id, doc, page);
  const [state, setState] = useState<{ key: string; data: PageResult | null; error: boolean }>(() => ({
    key,
    data: cache.get(key) ?? null,
    error: false,
  }));

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const hit = cache.get(key);
    if (hit) {
      setState({ key, data: hit, error: false });
      return;
    }
    setState({ key, data: null, error: false });
    loadPage(id, doc, page).then(
      (r) => alive && setState({ key, data: r, error: false }),
      () => alive && setState({ key, data: null, error: true }),
    );
    return () => {
      alive = false;
    };
  }, [id, doc, page, key, enabled]);

  return state.key === key ? state : { key, data: cache.get(key) ?? null, error: false };
}
