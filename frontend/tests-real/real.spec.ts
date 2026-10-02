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

test('batch of two PDFs with auto-approve → review queue → quick keys → approve clean → ZIP', async ({ page }) => {
  test.setTimeout(420_000);
  const problems = watchProblems(page);
  const tag = Date.now().toString(36);
  const titles = [`گروهی الف ${tag}`, `گروهی ب ${tag}`];

  await page.goto('/#/');
  await page.getByTestId('doc-type-exam').click();
  await page.getByTestId('mode-batch').click();
  await page.locator('#drop-booklet-input').setInputFiles([join(fixtures, 'typed.pdf'), join(fixtures, 'clean_scan.pdf')]);
  const titleInputs = page.getByTestId('batch-title');
  await expect(titleInputs).toHaveCount(2);
  await titleInputs.nth(0).fill(titles[0]);
  await titleInputs.nth(1).fill(titles[1]);
  await page.getByRole('radio', { name: 'کانون وکلا', exact: true }).click();
  await page.locator('#up-year').fill('1404');
  await expect(page.getByTestId('auto-approve')).toBeChecked();
  await page.getByTestId('submit-upload').click();
  await expect(page.getByText(/۲ پروژه ساخته شد/)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/#\/$/);

  // both projects of the batch become ready (the list polls every 2 s)
  const rows = titles.map((t) => page.getByTestId('project-row').filter({ hasText: t }));
  for (const r of rows) await expect(r.getByText('آماده‌ی بازبینی')).toBeVisible({ timeout: 240_000 });
  const group = page.getByTestId('batch-group').filter({ hasText: titles[0] });
  await expect(group.getByTestId('project-row')).toHaveCount(2);

  // project ids from the API
  const list = (await (await page.request.get('/api/projects')).json()) as { id: string; title: string; batch_id: string | null }[];
  const ids = titles.map((t) => list.find((p) => p.title === t)!.id);
  expect(list.find((p) => p.id === ids[0])!.batch_id).toBeTruthy();

  // review queue page (cross-project stream); open the first item if there is one
  await page.getByTestId('nav-queue').click();
  await expect(page).toHaveURL(/#\/queue/);
  await expect(page.locator('.queue-list, .empty-state').first()).toBeVisible();
  if ((await page.getByTestId('queue-item').count()) > 0) {
    await page.getByTestId('queue-item').first().click();
    await expect(page).toHaveURL(/from=queue/);
    await expect(page.getByTestId('queue-nav')).toBeVisible();
    await expect(page.getByTestId('current-number')).toBeVisible();
  }

  // quick key entry on the first project: change question 1's key
  const before = await (await page.request.get(`/api/projects/${ids[0]}`)).json();
  const q = [...before.questions].sort((a: { number: number }, b: { number: number }) => a.number - b.number)[0];
  const newKey = q.correct_key === '1' ? '2' : '1';
  await page.goto(`/#/p/${encodeURIComponent(ids[0])}?q=${q.number}`);
  await page.reload();
  await expect(page.getByTestId('current-number')).toBeVisible();
  await page.getByTestId('more-menu').click();
  await page.getByTestId('menu-keys').click();
  await page.getByTestId('keys-start').fill(String(q.number));
  await page.getByTestId('keys-input').fill(newKey);
  await page.getByTestId('keys-save').click();
  await expect(page.getByText(/کلید ۱ سؤال ثبت شد/)).toBeVisible();
  const after = await (await page.request.get(`/api/projects/${ids[0]}`)).json();
  expect(after.questions.find((x: { number: number }) => x.number === q.number)).toMatchObject({ correct_key: newKey, key_source: 'manual' });

  // approve all clean questions (if any are left after auto-approve)
  const clean = page.getByTestId('approve-clean');
  if ((await clean.count()) > 0) {
    await clean.click();
    await page.getByTestId('confirm-auto-approve').click();
    await expect(page.getByText(/سؤال سالم خودکار تأیید شد/)).toBeVisible();
  }
  // make sure at least one question is approved so the ZIP is not empty
  if (Number((await page.getByTestId('count-approved').textContent())?.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))) === 0) {
    await page.getByTestId('approve').click();
    await expect(page.getByTestId('count-approved')).toHaveText('۱');
  }

  // ZIP of Word files for the selected projects
  await page.goto('/#/');
  for (const t of titles) await page.getByRole('checkbox', { name: `انتخاب ${t}` }).check();
  const [zip] = await Promise.all([page.waitForEvent('download'), page.getByTestId('bulk-word').click()]);
  expect(zip.suggestedFilename()).toMatch(/\.zip$/);
  const bytes = readFileSync((await zip.path())!);
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

  expect(problems, problems.join('\n')).toEqual([]);
});
