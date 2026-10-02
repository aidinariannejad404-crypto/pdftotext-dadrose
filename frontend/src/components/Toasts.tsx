import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api';

type Kind = 'success' | 'error' | 'info';
export interface ToastAction {
  label: string;
  onClick: () => void;
}
interface Toast {
  id: number;
  kind: Kind;
  text: string;
  action?: ToastAction;
}
interface ToastApi {
  success: (text: string) => void;
  error: (errOrText: unknown, action?: ToastAction) => void;
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
    (kind: Kind, text: string, action?: ToastAction) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-3), { id, kind, text, action }]);
      setTimeout(() => remove(id), kind === 'error' ? (action ? 10000 : 6000) : 4000);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (t) => push('success', t),
      info: (t) => push('info', t),
      error: (e, action) => push('error', errorMessage(e), action),
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
            {t.action && (
              <button
                className="toast-action"
                onClick={() => {
                  remove(t.id);
                  t.action!.onClick();
                }}
              >
                {t.action.label}
              </button>
            )}
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
