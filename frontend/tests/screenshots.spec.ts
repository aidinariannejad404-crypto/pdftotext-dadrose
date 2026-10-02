import { test, type Page } from '@playwright/test';

// Not assertions — renders the main screens for visual review into ./screenshots.
const OUT = 'screenshots';

async function reset(page: Page) {
  await page.request.post('/api/__mock/reset');
}

for (const [name, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
] as const) {
  test.describe(name, () => {
    test.use({ viewport, deviceScaleFactor: name === 'mobile' ? 2 : 1 });

    test(`projects page (${name})`, async ({ page }) => {
      await reset(page);
      await page.goto('/#/');
      await page.getByTestId('project-row').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `${OUT}/projects-${name}.png`, fullPage: true });
    });

    test(`review page (${name})`, async ({ page }) => {
      await reset(page);
      await page.goto('/#/p/demo?q=2');
      await page.getByTestId('current-number').waitFor();
      await page.locator('.page-img:not(.is-loading)').first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${OUT}/review-${name}.png` });
      if (name === 'mobile') {
        await page.getByRole('tab', { name: 'تصویر' }).click();
        await page.waitForTimeout(800);
        await page.screenshot({ path: `${OUT}/review-${name}-image.png` });
        await page.getByRole('tab', { name: 'سؤال‌ها' }).click();
        await page.screenshot({ path: `${OUT}/review-${name}-list.png` });
      } else {
        // hover a word to show the compare tooltip, with OCR text panel open
        await page.getByTestId('toggle-ocr-text').check();
        await page.getByTestId('ov-flag').first().waitFor();
        const box = await page.getByTestId('ov-flag').first().boundingBox();
        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/review-${name}-compare.png` });
      }
    });

    test(`processing view (${name})`, async ({ page }) => {
      await reset(page);
      await page.goto('/#/p/p-processing');
      await page.locator('.processing-card').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `${OUT}/processing-${name}.png` });
    });
  });
}

test('review page dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await reset(page);
  await page.goto('/#/p/demo?q=9');
  await page.getByTestId('current-number').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/review-desktop-dark.png` });
});

test('upload form filled (desktop)', async ({ page }) => {
  await reset(page);
  await page.goto('/#/');
  await page.locator('#drop-booklet-input').setInputFiles([
    { name: 'IMG_0412.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
    { name: 'IMG_0413.HEIC', mimeType: 'image/heic', buffer: Buffer.from([0, 0, 0, 0]) },
    { name: 'kanoon-1404-camscanner.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF /Type /Page /Type /Page /Type /Page') },
  ]);
  await page.locator('#up-year').fill('1404');
  await page.locator('summary', { hasText: 'تنظیمات پیشرفته' }).click();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/upload-filled-desktop.png`, fullPage: true });
});

test('review extras (desktop): menu, help, completion', async ({ page }) => {
  await reset(page);
  await page.goto('/#/p/demo?q=4');
  await page.getByTestId('current-number').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/review-desktop-issues.png` });
  await page.getByTestId('more-menu').click();
  await page.screenshot({ path: `${OUT}/review-desktop-menu.png` });
  await page.keyboard.press('Escape');
  await page.getByTestId('help').click();
  await page.screenshot({ path: `${OUT}/review-desktop-help.png` });
  await page.keyboard.press('Escape');
  const project = await (await page.request.get('/api/projects/demo')).json();
  for (const q of project.questions) await page.request.put(`/api/projects/demo/questions/${q.number}`, { data: { status: 'approved' } });
  await page.goto('/#/p/demo?q=1');
  await page.reload();
  await page.getByTestId('done-card').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/review-desktop-done.png` });
});

for (const [name, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
] as const) {
  test(`text-mode review (${name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await reset(page);
    await page.goto('/#/p/notes?pg=booklet:1');
    await page.locator('textarea[data-field="text"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/text-review-${name}.png` });
    if (name === 'mobile') {
      await page.getByRole('tab', { name: 'تصویر' }).click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${OUT}/text-review-mobile-image.png` });
    }
  });
}

test('upload form, full-text type (desktop)', async ({ page }) => {
  await reset(page);
  await page.goto('/#/');
  await page.getByTestId('doc-type-text').click();
  await page.locator('#drop-booklet-input').setInputFiles({
    name: 'bank-nokat-madani.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF /Type /Page /Type /Page'),
  });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.upload-card').screenshot({ path: `${OUT}/upload-text-desktop.png` });
});

test('classification extras (desktop): article editor, group by article, stats', async ({ page }) => {
  await reset(page);
  await page.goto('/#/p/demo?q=3');
  await page.getByTestId('current-number').waitFor();
  await page.getByTestId('group-article').click();
  await page.getByTestId('article-add').click();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/review-desktop-classification.png` });
  await page.keyboard.press('Escape');
  await page.getByTestId('more-menu').click();
  await page.getByTestId('menu-stats').click();
  await page.screenshot({ path: `${OUT}/review-desktop-stats.png` });
});
