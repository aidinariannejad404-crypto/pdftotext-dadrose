import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icons';

export interface MenuItem {
  label: ReactNode;
  hint?: ReactNode;
  icon?: string;
  onSelect?: () => void;
  href?: string;
  download?: string;
  disabled?: boolean;
  danger?: boolean;
  testId?: string;
}

/** Small dropdown menu (button + list). Esc / outside click closes; arrow keys move focus. */
export default function Menu({ label, items, className }: { label: ReactNode; items: (MenuItem | 'sep')[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const els = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
        const i = els.indexOf(document.activeElement as HTMLElement);
        const next = els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length];
        next?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`menu ${className ?? ''}`} ref={ref}>
      <button
        ref={btn}
        className="btn btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        data-testid="more-menu"
      >
        {label} <Icon name="chev-down" size={14} />
      </button>
      {open && (
        <div className="menu-list" role="menu" id={id}>
          {items.map((it, i) =>
            it === 'sep' ? (
              <div key={i} className="menu-sep" role="separator" />
            ) : it.href && !it.disabled ? (
              <a
                key={i}
                role="menuitem"
                className="menu-item"
                href={it.href}
                download={it.download}
                onClick={() => setOpen(false)}
                data-testid={it.testId}
              >
                {it.icon && <Icon name={it.icon} size={16} />}
                <span className="menu-text">
                  {it.label}
                  {it.hint && <span className="menu-hint">{it.hint}</span>}
                </span>
              </a>
            ) : (
              <button
                key={i}
                role="menuitem"
                className={`menu-item ${it.danger ? 'is-danger' : ''}`}
                aria-disabled={it.disabled || undefined}
                onClick={() => {
                  if (it.disabled) return;
                  setOpen(false);
                  it.onSelect?.();
                }}
                data-testid={it.testId}
              >
                {it.icon && <Icon name={it.icon} size={16} />}
                <span className="menu-text">
                  {it.label}
                  {it.hint && <span className="menu-hint">{it.hint}</span>}
                </span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
