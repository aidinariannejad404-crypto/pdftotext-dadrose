import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Flag, Option, Question, QuestionUpdate } from './types';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

export interface Draft {
  subject_key: string | null;
  stem: string;
  options: Option[];
  correct_key: string | null;
  explanation: string;
  flags: Flag[]; // remaining suspicious words (resolved ones are removed locally, then PUT)
}

const KEYS = ['1', '2', '3', '4'];

export function draftFrom(q: Question): Draft {
  const byKey = new Map(q.options.map((o) => [o.key, o.text]));
  const extra = q.options.filter((o) => !KEYS.includes(o.key));
  return {
    subject_key: q.subject_key,
    stem: q.stem,
    options: [...KEYS.map((key) => ({ key, text: byKey.get(key) ?? '' })), ...extra],
    correct_key: q.correct_key,
    explanation: q.explanation,
    flags: q.flags,
  };
}

function toUpdate(d: Draft, withFlags: boolean): QuestionUpdate {
  const u: QuestionUpdate = {
    subject_key: d.subject_key,
    stem: d.stem,
    options: d.options,
    correct_key: d.correct_key,
    explanation: d.explanation,
  };
  if (withFlags) u.flags = d.flags;
  return u;
}

const DEBOUNCE_MS = 800;

/**
 * Local editable copy of the current question with debounced autosave (PUT).
 * `resetKey` changes whenever the question is replaced from outside (navigation,
 * re-OCR, reparse) — then the draft is reloaded from the server copy.
 */
export function useDraft(
  projectId: string,
  question: Question | null,
  resetKey: string,
  onSaved: (q: Question) => void,
  onError: (err: unknown) => void,
) {
  const [draft, setDraftState] = useState<Draft | null>(question ? draftFrom(question) : null);
  const [state, setState] = useState<SaveState>('saved');
  const draftRef = useRef(draft);
  const numberRef = useRef<number | null>(question?.number ?? null);
  const editSeq = useRef(0); // increments on every local edit
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<boolean> | null>(null);
  const dirty = useRef(false);
  const flagsDirty = useRef(false);
  const savedCb = useRef(onSaved);
  const errorCb = useRef(onError);
  savedCb.current = onSaved;
  errorCb.current = onError;

  // Reset from server copy when the question identity changes.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const d = question ? draftFrom(question) : null;
    draftRef.current = d;
    numberRef.current = question?.number ?? null;
    dirty.current = false;
    flagsDirty.current = false;
    setDraftState(d);
    setState('saved');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const doSave = useCallback(
    async (extra?: QuestionUpdate): Promise<boolean> => {
      if (timer.current) clearTimeout(timer.current);
      if (inflight.current) await inflight.current;
      const d = draftRef.current;
      const n = numberRef.current;
      if (!d || n === null) return false;
      if (!dirty.current && !extra) return true;
      const seqAtSend = editSeq.current;
      const sendFlags = flagsDirty.current;
      setState('saving');
      const p = (async () => {
        try {
          const q = await api.updateQuestion(projectId, n, { ...toUpdate(d, sendFlags), ...extra });
          if (numberRef.current === n && editSeq.current === seqAtSend) {
            dirty.current = false;
            flagsDirty.current = false;
            setState('saved');
          } else if (numberRef.current === n) {
            setState('dirty');
          }
          savedCb.current(q);
          return true;
        } catch (err) {
          if (numberRef.current === n) setState('error');
          errorCb.current(err);
          return false;
        } finally {
          inflight.current = null;
        }
      })();
      inflight.current = p;
      return p;
    },
    [projectId],
  );

  const update = useCallback(
    (patch: Partial<Draft>, immediate = false) => {
      const cur = draftRef.current;
      if (!cur) return;
      const next = { ...cur, ...patch };
      if (patch.flags) flagsDirty.current = true;
      draftRef.current = next;
      editSeq.current += 1;
      dirty.current = true;
      setDraftState(next);
      setState('dirty');
      if (timer.current) clearTimeout(timer.current);
      if (immediate) void doSave();
      else timer.current = setTimeout(() => void doSave(), DEBOUNCE_MS);
    },
    [doSave],
  );

  const setOption = useCallback(
    (key: string, text: string) => {
      const cur = draftRef.current;
      if (!cur) return;
      update({ options: cur.options.map((o) => (o.key === key ? { ...o, text } : o)) });
    },
    [update],
  );

  /** Save pending edits now (resolves true when nothing is left unsaved). */
  const flush = useCallback(() => doSave(), [doSave]);
  /** Save edits and set status in one request. */
  const saveWith = useCallback((extra: QuestionUpdate) => doSave(extra), [doSave]);

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  return { draft, state, update, setOption, flush, saveWith, isDirty: () => dirty.current };
}
