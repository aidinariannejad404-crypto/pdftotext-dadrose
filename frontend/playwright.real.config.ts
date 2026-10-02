import { defineConfig, devices } from '@playwright/test';

// End-to-end against a REAL running backend (FastAPI serving frontend/dist):
//   npm run build && (cd ../backend && uv run uvicorn app.main:app)   # http://127.0.0.1:8000
//   npm run test:real                                                   # REAL_BASE_URL to override
export default defineConfig({
  testDir: './tests-real',
  timeout: 300_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.REAL_BASE_URL || 'http://127.0.0.1:8000',
    locale: 'fa-IR',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
