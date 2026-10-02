import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/__mock/reset');
});

test('projects page lists projects and opens review', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: 'پروژه‌ها' })).toBeVisible();
  const rows = page.getByTestId('project-row');
  await expect(rows).toHaveCount(4);
  await expect(page.getByText('آماده‌ی بازبینی').first()).toBeVisible();
  await page.getByRole('link', { name: 'آزمون کانون وکلا ۱۴۰۳' }).click();
  await expect(page).toHaveURL(/#\/p\/demo/);
  // starts on the first not-approved question (Q1 is approved in the seed)
  await expect(page.getByTestId('current-number')).toHaveText('۲');
});

test('simplified upload: explains what is missing, auto-fills title and blueprint, accepts several images', async ({ page }) => {
  await page.goto('/#/');
  await page.getByTestId('doc-type-exam').click();
  // aria-disabled (not disabled) so clicking still explains what is missing
  await page.getByTestId('submit-upload').click({ force: true });
  await expect(page.getByTestId('submit-reason')).toContainText('فایل دفترچه را انتخاب کنید');
  await expect(page.getByTestId('submit-reason')).toContainText('سال آزمون را وارد کنید');

  // several page photos + a PDF, in page order
  await page.locator('#drop-booklet-input').setInputFiles([
    { name: 'page-1.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
    { name: 'page-2.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ]);
  await page.locator('#drop-booklet-input').setInputFiles({
    name: 'rest.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 /Type /Page /Type /Page'),
  });
  const rows = page.getByTestId('drop-booklet').getByTestId('file-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText('۲ صفحه');
  // reorder: move the PDF up one place
  await rows.nth(2).getByRole('button', { name: /انتقال rest.pdf به بالا/ }).click();
  await expect(rows.nth(1)).toContainText('rest.pdf');
  // remove one
  await rows.nth(0).getByRole('button', { name: /حذف page-1.jpg/ }).click();
  await expect(rows).toHaveCount(2);

  await page.getByRole('radio', { name: 'مرکز وکلا', exact: true }).click();
  await page.locator('#up-year').fill('1404');
  await expect(page.getByTestId('title-input')).toHaveValue('آزمون مرکز وکلا ۱۴۰۴');
  await page.locator('summary', { hasText: 'تنظیمات پیشرفته' }).click();
  await expect(page.getByTestId('blueprint-select')).toHaveValue('CENTER-1404');
  await page.locator('#up-year').fill('1399');
  await expect(page.getByTestId('blueprint-select')).toHaveValue('CENTER-1405'); // latest center
  await page.getByRole('radio', { name: 'کانون وکلا', exact: true }).click();
  await expect(page.getByTestId('blueprint-select')).toHaveValue('BAR-1405');
  await page.locator('#up-year').fill('1404');

  await expect(page.getByTestId('submit-reason')).toHaveCount(0);
  await page.getByTestId('submit-upload').click();
  await expect(page.getByText(/پردازش شروع شد/)).toBeVisible();
  // goes straight to the new project's processing view, which turns into the review
  await expect(page).toHaveURL(/#\/p\/p-/);
  await expect(page.locator('.processing-card')).toBeVisible();
  await expect(page.getByTestId('current-number')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.review-title h1')).toHaveText('آزمون کانون وکلا ۱۴۰۴');
});

test('test-book upload: no exam fields, optional subject applied to questions', async ({ page }) => {
  await page.goto('/#/');
  await page.getByTestId('doc-type-testbook').click();
  await expect(page.locator('#up-year')).toHaveCount(0);
  await expect(page.getByTestId('drop-explanations')).toHaveCount(0);
  await page.locator('#drop-booklet-input').setInputFiles({
    name: 'test-book.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4'),
  });
  await page.getByTestId('subject-select').selectOption('commercial');
  await expect(page.getByTestId('title-input')).toHaveValue('کتاب تست حقوق تجارت');
  await page.getByTestId('submit-upload').click();
  await expect(page).toHaveURL(/#\/p\/p-/);
  const id = decodeURIComponent(/#\/p\/([^?]+)/.exec(page.url())![1]);
  const p = await (await page.request.get(`/api/projects/${id}`)).json();
  expect(p).toMatchObject({ doc_type: 'questions', track: 'other', year: null, blueprint: 'auto' });
  await expect(page.getByTestId('current-number')).toBeVisible({ timeout: 20_000 });
  const ready = await (await page.request.get(`/api/projects/${id}`)).json();
  expect(ready.questions.every((q: { subject_key: string }) => q.subject_key === 'commercial')).toBe(true);
});

test('guide can be dismissed and is remembered', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.getByTestId('guide')).toBeVisible();
  await page.getByRole('button', { name: 'بستن راهنما' }).click();
  await expect(page.getByTestId('guide')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('project-row').first()).toBeVisible();
  await expect(page.getByTestId('guide')).toHaveCount(0);
});

test('select question, see flags, edit with inline highlight and autosave', async ({ page }) => {
  await page.goto('/#/p/demo?q=2');
  await expect(page.getByTestId('current-number')).toHaveText('۲');

  // flagged word is highlighted in the stem mirror
  const stemField = page.locator('.hl-field').first();
  await expect(stemField.locator('mark.hl-disagree')).toHaveText('مستاجر');

  // clicking the chip selects that word in the textarea and marks its bbox on the page
  await page.getByTestId('flag-chip').first().locator('.flag-word').click();
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

test('missing key issue is actionable and fixed by choosing the key', async ({ page }) => {
  await page.goto('/#/p/demo?q=4');
  await expect(page.getByTestId('qchip-4')).toHaveAttribute('data-state', 'error');
  await page.getByRole('button', { name: /گزینه‌ی درست مشخص نیست/ }).click();
  await expect(page.locator('[data-key-radio="1"]')).toBeFocused();
  await page.getByTestId('option-2').getByRole('radio').check();
  await expect(page.getByText('پاسخ درست: گزینه‌ی ۲ (دستی)')).toBeVisible();
  await expect(page.getByTestId('qchip-4')).not.toHaveAttribute('data-state', 'error');
});

test('suspicious words: use the alternative reading or keep the current one', async ({ page }) => {
  await page.goto('/#/p/demo?q=2');
  const cards = page.getByTestId('flag-chip');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('مستاجر');
  await expect(cards.first()).toContainText('یا مستأجر؟');
  // hovering highlights the box on the page image
  await cards.first().hover();
  await expect(page.locator('[data-testid="ov-flag"].is-hover')).toBeVisible();
  await cards.first().getByTestId('flag-use-alt').click();
  await expect(page.locator('textarea[data-field="stem"]')).toHaveValue(/^مستأجر بدون اذن/);
  await expect(cards).toHaveCount(1);
  // low-confidence word: just confirm it
  await cards.first().getByTestId('flag-keep').click();
  await expect(page.getByTestId('flag-chip')).toHaveCount(0);
  await expect(page.getByTestId('save-state')).toHaveText(/ذخیره شد/, { timeout: 5000 });
  const project = await (await page.request.get('/api/projects/demo')).json();
  const q2 = project.questions.find((q: { number: number }) => q.number === 2);
  expect(q2.flags).toHaveLength(0);
  expect(q2.stem.startsWith('مستأجر')).toBe(true);
});

test('next problem jumps to errors first, with F8 too', async ({ page }) => {
  await page.goto('/#/p/demo?q=2');
  await expect(page.getByTestId('next-problem').first()).toContainText('خطای بعدی');
  await page.getByTestId('next-problem').first().click();
  await expect(page.getByTestId('current-number')).toHaveText('۴');
  await page.keyboard.press('F8');
  await expect(page.getByTestId('current-number')).toHaveText('۶');
});

test('completion card appears when everything is approved', async ({ page }) => {
  const project = await (await page.request.get('/api/projects/demo')).json();
  for (const q of project.questions) {
    if (q.number !== 11) await page.request.put(`/api/projects/demo/questions/${q.number}`, { data: { status: 'approved' } });
  }
  await page.goto('/#/p/demo?q=11');
  await expect(page.getByTestId('done-card')).toHaveCount(0);
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('done-card')).toBeVisible();
  await expect(page.getByTestId('done-card').getByTestId('download-word')).toHaveAttribute('href', /export\.docx\?only_approved=1/);
  await expect(page.getByTestId('count-approved')).toHaveText('۱۰');
});

test('help dialog opens with ? and lists shortcuts', async ({ page }) => {
  await page.goto('/#/p/demo?q=2');
  await page.getByTestId('current-number').waitFor();
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'راهنمای بازبینی' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('F8');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('delete question asks for confirmation', async ({ page }) => {
  await page.goto('/#/p/demo?q=3');
  await page.getByRole('button', { name: 'حذف', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'حذف سؤال ۳' })).toBeVisible();
  await page.getByTestId('confirm-delete').click();
  await expect(page.getByTestId('qchip-3')).toHaveCount(0);
});

test('page viewer shows OCR tooltip on hover', async ({ page }) => {
  await page.goto('/#/p/demo?q=2');
  const word = page.getByTestId('ov-word').first();
  await word.waitFor();
  await word.hover();
  await expect(page.getByTestId('word-tip')).toBeVisible();
  await expect(page.getByTestId('word-tip')).toContainText('اطمینان');
});

test('Word download is the primary export; push is disabled when not configured', async ({ page }) => {
  await page.goto('/#/p/demo');
  const word = page.locator('.review-header').getByTestId('download-word');
  await expect(word).toHaveAttribute('href', '/api/projects/demo/export.docx?only_approved=1');
  await expect(word).toContainText('۲ سؤال');
  const res = await page.request.get('/api/projects/demo/export.docx');
  expect(res.headers()['content-type']).toContain('wordprocessingml');
  await page.getByTestId('more-menu').click();
  await expect(page.getByTestId('menu-push')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('menu-push')).toContainText('پیکربندی نشده');
  await expect(page.getByTestId('menu-json')).toHaveAttribute('href', /export\.json/);
});

test('upload as full text hides exam fields and requires only files + title', async ({ page }) => {
  await page.goto('/#/');
  await page.getByTestId('doc-type-text').click();
  await expect(page.locator('#up-year')).toHaveCount(0);
  await expect(page.getByTestId('drop-explanations')).toHaveCount(0);
  await page.locator('#drop-booklet-input').setInputFiles({
    name: 'jozve-madani.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4'),
  });
  await expect(page.getByTestId('title-input')).toHaveValue('jozve madani');
  await page.getByTestId('title-input').fill('جزوه‌ی مدنی');
  await expect(page.getByTestId('submit-reason')).toHaveCount(0);
  await page.getByTestId('submit-upload').click();
  await expect(page).toHaveURL(/#\/p\/p-/);
  const id = decodeURIComponent(/#\/p\/([^?]+)/.exec(page.url())![1]);
  const full = await (await page.request.get(`/api/projects/${id}`)).json();
  expect(full.doc_type).toBe('text');
  await expect(page.getByTestId('current-page')).toBeVisible({ timeout: 20_000 });
});

test('question mode shows editable source of the question', async ({ page }) => {
  await page.goto('/#/p/demo?q=3');
  const src = page.locator('input[data-field="source_ref"]');
  await expect(src).toHaveValue('ارشد سراسری-۷۸');
  await src.fill('ارشد سراسری-۷۹');
  await expect(page.getByTestId('save-state')).toHaveText(/ذخیره شد/, { timeout: 5000 });
  const project = await (await page.request.get('/api/projects/demo')).json();
  expect(project.questions.find((q: { number: number }) => q.number === 3).source_ref).toBe('ارشد سراسری-۷۹');
});

test('text mode: edit with highlights, autosave, approve and next, revert', async ({ page }) => {
  await page.goto('/#/p/notes');
  // page 1 is approved in the seed → starts on page 2
  await expect(page.getByTestId('current-page')).toHaveText('صفحه‌ی ۲');
  await expect(page.getByTestId('pages-approved')).toHaveText('۱');
  const editor = page.locator('textarea[data-field="text"]');
  await expect(editor).toHaveValue(/شرایط اساسی صحت معامله/);
  // flagged OCR words are highlighted inside the editor
  await expect(page.locator('.text-editor mark.hl-disagree').first()).toHaveText('اهلیت');
  await expect(page.locator('.text-editor mark.hl-low_conf')).toHaveText('باطناً');
  await page.getByTestId('text-flags').getByRole('button', { name: /اهلیت/ }).click();
  await expect(page.locator('[data-testid="ov-flag"].is-active')).toBeVisible();

  await editor.fill('متن اصلاح‌شده‌ی صفحه‌ی دوم');
  await expect(page.getByTestId('save-state')).toHaveText(/ذخیره شد/, { timeout: 5000 });
  let t = await (await page.request.get('/api/projects/notes/pages/booklet/1/text')).json();
  expect(t).toMatchObject({ text: 'متن اصلاح‌شده‌ی صفحه‌ی دوم', edited: true });

  // revert
  await page.getByTestId('revert-text').click();
  await page.getByTestId('confirm-revert').click();
  await expect(editor).toHaveValue(/شرایط اساسی صحت معامله/);
  t = await (await page.request.get('/api/projects/notes/pages/booklet/1/text')).json();
  expect(t.edited).toBe(false);

  // approve → next page
  await page.getByTestId('approve-page').click();
  await expect(page.getByTestId('current-page')).toHaveText('صفحه‌ی ۳');
  await expect(page.getByTestId('pages-approved')).toHaveText('۲');
  await expect(page.getByTestId('page-booklet:1')).toHaveAttribute('data-approved', 'true');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('done-card')).toBeVisible();
  await expect(page.getByTestId('done-card').getByTestId('download-word')).toHaveAttribute('href', /export-text\.docx/);
});

test('text mode: next suspicious page and switching modes', async ({ page }) => {
  await page.goto('/#/p/notes?pg=booklet:2');
  await expect(page.getByTestId('current-page')).toHaveText('صفحه‌ی ۳');
  await page.getByTestId('next-suspicious').first().click();
  await expect(page.getByTestId('current-page')).toHaveText('صفحه‌ی ۲'); // page 1 approved, page 2 has flags
  await page.getByTestId('more-menu').click();
  await expect(page.getByTestId('menu-txt')).toHaveAttribute('href', /export\.txt/);
  await page.getByTestId('menu-mode').click();
  await page.getByTestId('confirm-mode').click();
  await expect(page.getByText('در این فایل سؤال تستی پیدا نشد.')).toBeVisible();
  // and back to text from question mode
  await page.getByTestId('more-menu').click();
  await page.getByTestId('menu-mode').click();
  await page.getByTestId('confirm-mode').click();
  await expect(page.getByTestId('current-page')).toBeVisible();
});

test('many suspicious words stay compact: stem and options remain above the fold', async ({ page }) => {
  const project = await (await page.request.get('/api/projects/demo')).json();
  const q2 = project.questions.find((q: { number: number }) => q.number === 2);
  const words = q2.stem.split(' ').slice(0, 9).map((w: string) => w.replace(/[.،؟]/g, ''));
  const optWords = q2.options[0].text.split(' ').slice(0, 4);
  const flags = [
    ...words.map((w: string, i: number) => ({ field: 'stem', word: w, doc: 'booklet', page: 0, bbox: null, reason: i % 2 ? 'low_conf' : 'disagree', alt: i % 2 ? null : w + 'ه' })),
    ...optWords.map((w: string) => ({ field: 'option:1', word: w, doc: 'booklet', page: 0, bbox: null, reason: 'low_conf', alt: null })),
    { field: 'explanation', word: 'ماده‌ی', doc: 'explanations', page: 0, bbox: null, reason: 'low_conf', alt: null },
    { field: 'stem', word: 'ارشد', doc: 'booklet', page: 0, bbox: null, reason: 'low_conf', alt: null }, // not in text
  ];
  await page.request.put('/api/projects/demo/questions/2', { data: { flags } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/p/demo?q=2');
  await expect(page.locator('.flags-box > .flag-list [data-testid="flag-chip"]')).toHaveCount(4);
  await expect(page.getByTestId('flags-more')).toContainText('نمایش همه (۱۳)');
  await expect(page.locator('.flags-expl summary')).toContainText('در پاسخ تشریحی (۱)');
  await expect(page.getByTestId('flags-drop-stale')).toBeVisible();
  await page.screenshot({ path: 'screenshots/review-desktop-many-flags.png' });
  // stem and all four options are visible in the editor viewport
  const scroller = await page.locator('.editor-scroll').boundingBox();
  const opt4 = await page.getByTestId('option-4').boundingBox();
  expect(opt4!.y + opt4!.height).toBeLessThanOrEqual(scroller!.y + scroller!.height);
  await page.getByTestId('flags-more').click();
  await expect(page.locator('.flags-box > .flag-list [data-testid="flag-chip"]')).toHaveCount(13);
  await page.getByTestId('flags-drop-stale').click();
  await expect(page.getByTestId('flags-drop-stale')).toHaveCount(0);
});

test('classification: topic with suggestions becomes manual', async ({ page }) => {
  await page.goto('/#/p/demo?q=7');
  const topic = page.locator('input[data-field="topic"]');
  await expect(topic).toHaveValue('');
  const listId = await topic.getAttribute('list');
  await expect(page.locator(`datalist[id="${listId}"] option[value="علل موجهه‌ی جرم"]`)).toHaveCount(1);
  await topic.fill('علل موجهه‌ی جرم');
  await topic.blur();
  await expect(page.getByTestId('save-state')).toHaveText(/ذخیره شد/, { timeout: 5000 });
  await expect(page.locator('.classify-topic').getByTestId('src-badge')).toHaveText('دستی');
  const p = await (await page.request.get('/api/projects/demo')).json();
  const q7 = p.questions.find((q: { number: number }) => q.number === 7);
  expect(q7.topic).toBe('علل موجهه‌ی جرم');
  expect(q7.classification.topic_source).toBe('manual');
});

test('classification: add and remove law articles', async ({ page }) => {
  await page.goto('/#/p/demo?q=7');
  await expect(page.getByTestId('article-chip')).toHaveCount(0);
  await page.getByTestId('article-add').click();
  await expect(page.getByTestId('article-law')).toHaveValue('penal_code'); // subject's law preselected
  await page.getByTestId('article-number').fill('۱۵۶');
  await page.getByTestId('article-save').click();
  await expect(page.getByTestId('article-chip')).toHaveText(/ماده ۱۵۶ · قانون مجازات اسلامی/);
  await expect(page.getByTestId('save-state')).toHaveText(/ذخیره شد/, { timeout: 5000 });
  let p = await (await page.request.get('/api/projects/demo')).json();
  expect(p.questions.find((q: { number: number }) => q.number === 7).articles[0]).toMatchObject({
    law_key: 'penal_code', number: '۱۵۶', kind: 'ماده', source: 'manual',
  });
  // constitution → «اصل»
  await page.getByTestId('article-add').click();
  await page.getByTestId('article-law').selectOption('constitution');
  await page.getByTestId('article-number').fill('36');
  await page.getByTestId('article-save').click();
  await expect(page.getByTestId('article-chip').nth(1)).toHaveText(/اصل ۳۶ · قانون اساسی/);
  // remove the first
  await page.getByRole('button', { name: /حذف ماده ۱۵۶/ }).click();
  await expect(page.getByTestId('article-chip')).toHaveCount(1);
  await expect(page.getByTestId('save-state')).toHaveText(/ذخیره شد/, { timeout: 5000 });
  p = await (await page.request.get('/api/projects/demo')).json();
  expect(p.questions.find((q: { number: number }) => q.number === 7).articles).toHaveLength(1);
});

test('navigator: group by topic / article and search by article number', async ({ page }) => {
  await page.goto('/#/p/demo?q=2');
  await page.getByTestId('group-topic').click();
  const titles = page.locator('.nav-group-title');
  await expect(titles.filter({ hasText: 'عقد اجاره' })).toHaveCount(1);
  await expect(titles.last()).toContainText('بدون مبحث');
  await page.getByTestId('group-article').click();
  await expect(titles.filter({ hasText: 'ماده ۴۷۴ · قانون مدنی' })).toHaveCount(1);
  await page.getByTestId('nav-search').fill('۴۷۴');
  await expect(page.locator('.qchip')).toHaveCount(1);
  await expect(page.getByTestId('qchip-2')).toBeVisible();
  await page.getByTestId('nav-search').fill('سهامی');
  await expect(page.getByTestId('qchip-11')).toBeVisible();
});

test('auto-classify dialog fills missing topics and keeps manual ones; stats', async ({ page }) => {
  await page.goto('/#/p/demo?q=1');
  await page.getByTestId('more-menu').click();
  await page.getByTestId('menu-classify').click();
  await expect(page.getByRole('dialog')).toContainText('دست نمی‌خورند');
  await expect(page.getByRole('radio', { name: /Gemini/ })).toBeDisabled();
  await page.getByTestId('scope-missing').check();
  await page.getByTestId('confirm-classify').click();
  await expect(page.getByText(/طبقه‌بندی انجام شد/)).toBeVisible();
  const p = await (await page.request.get('/api/projects/demo')).json();
  const byN = (n: number) => p.questions.find((q: { number: number }) => q.number === n);
  expect(byN(7).topic).toBe('علل موجهه‌ی جرم');
  expect(byN(6).topic).toBe('شروع به جرم'); // manual, untouched
  await page.getByTestId('more-menu').click();
  await page.getByTestId('menu-stats').click();
  await expect(page.getByTestId('stats')).toContainText('مباحث پرتکرار');
  await expect(page.getByTestId('stats')).toContainText('ماده ۴۷۴ · قانون مدنی');
});

test('direct push: connection test and site job status', async ({ page }) => {
  await page.request.post('/api/__mock/push-config', { data: { on: true } });
  await page.goto('/#/p/demo');
  await page.getByTestId('more-menu').click();
  await expect(page.getByTestId('menu-push')).not.toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('menu-push').click();
  await page.getByTestId('push-check').click();
  await expect(page.getByTestId('push-check-result')).toContainText('اتصال به سایت برقرار است');
  await page.getByTestId('push-send').click();
  await expect(page.getByTestId('push-result')).toContainText('۲ سؤال');
  await expect(page.getByTestId('push-result')).toContainText('در حال پردازش در سایت… (در صف)');
  await expect(page.getByTestId('push-result')).toContainText('(در حال پردازش)', { timeout: 8_000 });
  await expect(page.getByTestId('push-result')).toContainText('آماده‌ی بازبینی در پنل سایت ✓ (نیازمند بازبینی)', { timeout: 12_000 });
});
