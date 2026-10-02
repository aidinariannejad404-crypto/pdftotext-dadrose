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
