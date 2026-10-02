import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Real end-to-end flow against a running backend. Inputs are generated at runtime by the
// backend's fixture generator (no private files): typed booklet PDF + phone-scan photo.

const BACKEND_DIR = fileURLToPath(new URL('../../backend', import.meta.url));
let fixtures = '';

test.beforeAll(() => {
  fixtures = mkdtempSync(join(tmpdir(), 'dadrose-real-'));
  execFileSync('uv', ['run', 'python', '-m', 'tests.fixtures_gen', fixtures], { cwd: BACKEND_DIR, stdio: 'inherit' });
  for (const f of ['typed.pdf', 'phone_scan.jpg']) {
    if (!existsSync(join(fixtures, f))) throw new Error(`fixture generator did not write ${f}`);
  }
});

/** Collect console errors and HTTP 4xx/5xx; the test fails if any were seen. */
function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    // downloads are aborted by the browser once saved; ignore those
    if (!/export/.test(r.url())) problems.push(`failed: ${r.method()} ${r.url()} ${r.failure()?.errorText}`);
  });
  return problems;
}

async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-state')).toHaveText(/ذخیره شد/, { timeout: 15_000 });
}

test('booklet as official exam → review, approve, Word; then full-text mode → TXT', async ({ page }) => {
  const problems = watchProblems(page);

  await page.goto('/#/');
  await page.getByTestId('doc-type-exam').click();
  await page.locator('#drop-booklet-input').setInputFiles(join(fixtures, 'typed.pdf'));
  await page.getByRole('radio', { name: 'کانون وکلا', exact: true }).click();
  await page.locator('#up-year').fill('1404');
  await expect(page.getByTestId('title-input')).toHaveValue('آزمون کانون وکلا ۱۴۰۴');
  await page.getByTestId('submit-upload').click();

  // navigates straight to the new project's processing view, then the review
  await expect(page).toHaveURL(/#\/p\/[^?]+/, { timeout: 30_000 });
  const projectId = decodeURIComponent(/#\/p\/([^?]+)/.exec(page.url())![1]);
  await expect(page.getByTestId('current-number')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('count-total')).toHaveText('۴');

  // edit the stem
  const stem = page.locator('textarea[data-field="stem"]');
  const original = await stem.inputValue();
  const marker = ' (ویرایش آزمون)';
  await stem.fill(original + marker);
  await waitSaved(page);
  const qnum = await page.getByTestId('current-number').textContent();

  // resolve one suspicious word if there is any
  const keep = page.getByTestId('flag-keep');
  if ((await keep.count()) > 0) {
    const before = await page.getByTestId('flag-chip').count();
    await keep.first().click();
    await expect(page.getByTestId('flag-chip')).toHaveCount(before - 1);
    await waitSaved(page);
  }

  // approve → counts update and we move on
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('count-approved')).toHaveText('۱');

  // reload: the edit and the approval persisted
  const asciiQ = (qnum ?? '').replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  await page.goto(`/#/p/${encodeURIComponent(projectId)}?q=${asciiQ}`);
  await page.reload();
  await expect(page.getByTestId('current-number')).toHaveText(qnum ?? '');
  await expect(page.locator('textarea[data-field="stem"]')).toHaveValue(original + marker);
  await expect(page.getByTestId('count-approved')).toHaveText('۱');

  // download Word (only approved → 1 question)
  const [docx] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.review-header').getByTestId('download-word').click(),
  ]);
  expect(docx.suggestedFilename()).toMatch(/\.docx$/);
  const docxBytes = readFileSync((await docx.path())!);
  expect(docxBytes.subarray(0, 2).toString('latin1')).toBe('PK');

  // switch to full-text mode
  await page.getByTestId('more-menu').click();
  await page.getByTestId('menu-mode').click();
  await page.getByTestId('confirm-mode').click();
  await expect(page.getByTestId('current-page')).toBeVisible({ timeout: 30_000 });
  const text = page.locator('textarea[data-field="text"]');
  await expect(text).not.toHaveValue('');
  const pageText = await text.inputValue();
  await text.fill(`${pageText}\nیادداشت آزمون`);
  await waitSaved(page);
  await page.getByTestId('approve-page').click();
  await expect(page.getByTestId('pages-approved')).toHaveText('۱');

  // TXT download contains the edit
  await page.getByTestId('more-menu').click();
  const [txt] = await Promise.all([page.waitForEvent('download'), page.getByTestId('menu-txt').click()]);
  expect(txt.suggestedFilename()).toMatch(/\.txt$/);
  expect(readFileSync((await txt.path())!, 'utf8')).toContain('یادداشت آزمون');

  expect(problems, problems.join('\n')).toEqual([]);
});

test('phone photo as full text on a 390px phone', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fa-IR' });
  const page = await context.newPage();
  const problems = watchProblems(page);

  await page.goto('/#/');
  await page.getByTestId('doc-type-text').click();
  await expect(page.locator('#up-year')).toHaveCount(0);
  await page.locator('#drop-booklet-input').setInputFiles(join(fixtures, 'phone_scan.jpg'));
  await page.getByTestId('title-input').fill('عکس موبایل — متن کامل');
  await page.getByTestId('submit-upload').click();

  await expect(page).toHaveURL(/#\/p\/[^?]+/, { timeout: 30_000 });
  await expect(page.getByTestId('current-page')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('textarea[data-field="text"]')).not.toHaveValue('');
  // primary actions stay reachable in the sticky bottom bar
  const approve = page.getByTestId('mobile-approve');
  await expect(approve).toBeInViewport();
  await approve.click();
  await expect(page.getByTestId('pages-approved')).toHaveText('۱');
  await page.getByRole('tab', { name: 'تصویر' }).click();
  await expect(page.locator('.page-img')).toBeVisible();

  expect(problems, problems.join('\n')).toEqual([]);
  await context.close();
});
