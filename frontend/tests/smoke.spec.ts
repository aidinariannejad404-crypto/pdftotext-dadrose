import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/__mock/reset');
});

test('projects page lists projects and opens review', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: 'پروژه‌ها' })).toBeVisible();
  const rows = page.getByTestId('project-row');
  await expect(rows).toHaveCount(3);
  await expect(page.getByText('آماده‌ی بازبینی')).toBeVisible();
  await page.getByRole('link', { name: 'آزمون کانون وکلا ۱۴۰۳' }).click();
  await expect(page).toHaveURL(/#\/p\/demo/);
  // starts on the first not-approved question (Q1 is approved in the seed)
  await expect(page.getByTestId('current-number')).toHaveText('۲');
});

test('upload creates a project that finishes processing', async ({ page }) => {
  await page.goto('/#/');
  await page.locator('#drop-booklet-input').setInputFiles({
    name: 'booklet.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 mock'),
  });
  await page.getByLabel('عنوان', { exact: true }).fill('آزمون آزمایشی');
  await page.getByRole('button', { name: 'شروع پردازش' }).click();
  await expect(page.getByText('فایل‌ها بارگذاری شد؛ پردازش آغاز شد.')).toBeVisible();
  const row = page.getByTestId('project-row').filter({ hasText: 'آزمون آزمایشی' });
  await expect(row).toBeVisible();
  await expect(row.getByText('آماده‌ی بازبینی')).toBeVisible({ timeout: 15_000 });
});

test('select question, see flags, edit with inline highlight and autosave', async ({ page }) => {
  await page.goto('/#/p/demo?q=2');
  await expect(page.getByTestId('current-number')).toHaveText('۲');

  // flagged word is highlighted in the stem mirror
  const stemField = page.locator('.hl-field').first();
  await expect(stemField.locator('mark.hl-disagree')).toHaveText('مستاجر');

  // clicking the chip selects that word in the textarea and marks its bbox on the page
  await page.getByTestId('flag-chip').first().click();
  const selected = await page.evaluate(() => {
    const el = document.activeElement as HTMLTextAreaElement;
    return el.value.slice(el.selectionStart, el.selectionEnd);
  });
  expect(selected).toBe('مستاجر');
  await expect(page.locator('[data-testid="ov-flag"].is-active')).toBeVisible();

  // fixing the word removes the highlight; autosave kicks in
  const stem = page.locator('textarea[data-field="stem"]');
  await stem.fill('مستأجر بدون اذن موجر عین مستأجره را به دیگری اجاره داده است. حکم قضیه چیست؟');
  await expect(stemField.locator('mark')).toHaveCount(0);
  await expect(page.getByTestId('save-state')).toHaveText(/ذخیره شد/, { timeout: 5000 });
  const res = await page.request.get('/api/projects/demo');
  const project = await res.json();
  expect(project.questions.find((q: { number: number }) => q.number === 2).stem.startsWith('مستأجر')).toBe(true);

  // a typed flag word gets highlighted again while editing
  await stem.fill('مستاجر جدید');
  await expect(stemField.locator('mark.hl-disagree')).toHaveText('مستاجر');
});

test('navigator selects questions and keyboard navigation works', async ({ page }) => {
  await page.goto('/#/p/demo');
  await page.getByTestId('qchip-9').click();
  await expect(page.getByTestId('current-number')).toHaveText('۹');
  await expect(page.getByTestId('qchip-9')).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.getByTestId('current-number')).toHaveText('۱۰');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.getByTestId('current-number')).toHaveText('۹');
  // filter: problems only hides clean approved ones
  await page.getByRole('radio', { name: /مشکل‌دار/ }).click();
  await expect(page.getByTestId('qchip-1')).toHaveCount(0);
});

test('approve moves to next unapproved question and updates counts', async ({ page }) => {
  await page.goto('/#/p/demo?q=2');
  await expect(page.getByTestId('count-approved')).toHaveText('۲');
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('current-number')).toHaveText('۳');
  await expect(page.getByTestId('qchip-2')).toHaveAttribute('data-state', 'approved');
  await expect(page.getByTestId('count-approved')).toHaveText('۳');
  // Ctrl+Enter approves too
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('current-number')).toHaveText('۴');
  await expect(page.getByTestId('count-approved')).toHaveText('۴');
});

test('setting the key fixes a missing-key error', async ({ page }) => {
  await page.goto('/#/p/demo?q=4');
  await expect(page.getByTestId('qchip-4')).toHaveAttribute('data-state', 'error');
  await page.getByTestId('option-2').getByRole('radio').check();
  await expect(page.getByText('کلید: گزینه‌ی ۲ — دستی')).toBeVisible();
  await expect(page.getByTestId('qchip-4')).not.toHaveAttribute('data-state', 'error');
});

test('page viewer shows OCR tooltip on hover', async ({ page }) => {
  await page.goto('/#/p/demo?q=2');
  const word = page.getByTestId('ov-word').first();
  await word.waitFor();
  await word.hover();
  await expect(page.getByTestId('word-tip')).toBeVisible();
  await expect(page.getByTestId('word-tip')).toContainText('اطمینان');
});

test('push shows result', async ({ page }) => {
  await page.goto('/#/p/demo');
  await page.getByRole('button', { name: 'ارسال به سایت' }).click();
  await page.getByRole('button', { name: /ارسال ۲ سؤال/ }).click();
  await expect(page.getByTestId('push-result')).toContainText('created');
});
