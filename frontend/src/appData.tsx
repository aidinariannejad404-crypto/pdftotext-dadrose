import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import type { EngineName, Health, Meta } from './types';

interface AppData {
  health: Health | null;
  meta: Meta | null;
  subjectName: (key: string | null | undefined) => string;
  engineAvailable: (e: EngineName) => boolean;
}

const Ctx = createContext<AppData | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    api.meta().then(setMeta).catch(() => setMeta({ blueprints: [], subjects: [] }));
  }, []);

  const value = useMemo<AppData>(() => {
    const names = new Map((meta?.subjects ?? []).map((s) => [s.key, s.name]));
    return {
      health,
      meta,
      subjectName: (key) => (key ? names.get(key) ?? key : 'بدون درس'),
      engineAvailable: (e) => {
        if (!health) return e === 'auto';
        if (e === 'auto') return true;
        return Boolean(health.engines[e]);
      },
    };
  }, [health, meta]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppDataProvider missing');
  return v;
}
