const PATHS: Record<string, string> = {
  upload: 'M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zm0 0v5h5M9 13h6M9 17h6',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  check: 'M5 12.5 10 17l9-10',
  'chev-up': 'm6 15 6-6 6 6',
  'chev-down': 'm6 9 6 6 6-6',
  'chev-left': 'm15 6-6 6 6 6',
  'chev-right': 'm9 6 6 6-6 6',
  back: 'M5 12h14m0 0-6-6m6 6-6 6',
  'zoom-in': 'M11 8v6M8 11h6m6 9-4.3-4.3M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  'zoom-out': 'M8 11h6m6 9-4.3-4.3M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  fit: 'M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4m11-5v4a1 1 0 0 1-1 1h-4',
  download: 'M12 4v12m0 0-4-4m4 4 4-4M4 20h16',
  send: 'M21 3 10 14M21 3l-7 18-4-7-7-4z',
  refresh: 'M20 11a8 8 0 0 0-14.9-3M4 4v4h4m-4 5a8 8 0 0 0 14.9 3M20 20v-4h-4',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  plus: 'M12 5v14M5 12h14',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15 9.5a1.5 1.5 0 1 0 0-.01',
  text: 'M4 6h16M4 10h16M4 14h10M4 18h12',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  save: 'M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1zM8 4v5h7V4M8 20v-6h8v6',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12m10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
};

export function Icon({ name, className, size = 18 }: { name: string; className?: string; size?: number }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

export function BrandMark() {
  return (
    <svg className="brand-mark" width="36" height="36" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#0b2545" />
      <path d="M9 8h8.5a6.5 6.5 0 0 1 0 13H13v3H9z" fill="#e7b72c" />
      <path d="M13 12h4.3a2.5 2.5 0 0 1 0 5H13z" fill="#0b2545" />
    </svg>
  );
}
