import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api';

type Kind = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  kind: Kind;
  text: string;
}
interface ToastApi {
  success: (text: string) => void;
  error: (errOrText: unknown) => void;
  info: (text: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'خطای ناشناخته';
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: Kind, text: string) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-3), { id, kind, text }]);
      setTimeout(() => remove(id), kind === 'error' ? 7000 : 3500);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (t) => push('success', t),
      info: (t) => push('info', t),
      error: (e) => push('error', errorMessage(e)),
    }),
    [push],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="اعلان‌ها">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span className="toast-text">{t.text}</span>
            <button className="toast-close" onClick={() => remove(t.id)} aria-label="بستن">
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('ToastProvider missing');
  return v;
}
