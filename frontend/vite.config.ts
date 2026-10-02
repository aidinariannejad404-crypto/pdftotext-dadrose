import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { mockApiPlugin } from './mock/plugin';

// `npm run dev:mock` (mode "mock") serves a fake API in-process so the UI can be
// exercised without the FastAPI backend; otherwise /api is proxied to it.
export default defineConfig(({ mode }) => {
  const plugins: PluginOption[] = [react()];
  if (mode === 'mock') plugins.push(mockApiPlugin());
  return {
    plugins,
    base: '/',
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
    server: {
      port: 5173,
      proxy: mode === 'mock' ? undefined : { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } },
    },
  };
});
