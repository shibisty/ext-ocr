// Живая проверка собранного расширения в Chrome: загрузка dist/, распознавание картинки, история, экспорт.
// Нужен Chrome for Testing или Chromium (обычный Chrome 137+ не грузит распакованные расширения из командной строки):
//   CHROME_PATH=/путь/к/chrome npm run test:e2e
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const image = path.join(root, 'e2e/fixtures/hello.png');
const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const headless = process.env.HEADED ? false : true;

if (!fs.existsSync(path.join(dist, 'manifest.json'))) { console.error('Сначала npm run build'); process.exit(1); }

const fails: string[] = [];
const check = (ok: unknown, what: string) => { console.log(ok ? '  ✓' : '  ✗', what); if (!ok) fails.push(what); };

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-e2e-'));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath, headless, acceptDownloads: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run']
});
const errors: string[] = [];
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(sw.url()).host;
  console.log('Расширение', id);
  check(sw.url().endsWith('/background.js'), 'service worker background.js запущен');

  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push('page: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('page: ' + e.message));
  await page.goto(`chrome-extension://${id}/ocr.html`);
  await page.waitForFunction(() => document.getElementById('stats')?.textContent === 'Очередь пуста');
  check(true, 'ocr.html открылась, очередь пуста');

  await page.setInputFiles('#file', image);
  await page.waitForSelector('.card', { timeout: 15000 });
  check(true, 'картинка добавлена в очередь');
  await page.waitForSelector('.card.st-done, .card.st-error', { timeout: 180000 });
  const card = await page.locator('.card').first().innerText();
  console.log('    ' + card.replace(/\n/g, ' ⏎ '));
  check(/st-done/.test(await page.locator('.card').first().getAttribute('class') ?? ''), 'распознано без ошибки');
  check(/Hello/i.test(card) && /World/i.test(card), 'текст «Hello World» найден');
  check(/Привет/i.test(card), 'кириллица «Привет» найдена');

  const contexts = await sw.evaluate(async () =>
    (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] })).map((c) => c.documentUrl));
  check(contexts.some((u) => u?.endsWith('/engine.html')), 'offscreen engine.html работает');

  // экспорт
  await page.waitForFunction(() => !(document.getElementById('export') as HTMLButtonElement).disabled);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  const file = await dl.path();
  const head = fs.readFileSync(file).subarray(0, 2).toString();
  check(dl.suggestedFilename().endsWith('.xlsx') && head === 'PK', 'экспорт .xlsx скачан');

  // история и попап
  await page.click('.tabs button[data-tab="history"]');
  check((await page.locator('#jobs').innerText()).includes('hello.png'), 'задание в истории');

  const popup = await ctx.newPage();
  popup.on('pageerror', (e) => errors.push('popup: ' + e.message));
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForSelector('.card.st-done', { timeout: 10000 });
  const pill = await popup.waitForFunction(() => /ожидание|обработка/.test(document.getElementById('pill')?.textContent ?? ''),
    undefined, { timeout: 5000 }).then(() => true, () => false);
  check(pill, 'попап видит движок');

  // повтор через «Переделать»
  await popup.click('.card [data-act="redo"]');
  await popup.waitForFunction(() => document.querySelector('.card')?.classList.contains('st-done') && document.getElementById('pill')?.textContent === 'ожидание',
    undefined, { timeout: 120000 });
  check(true, '«Переделать» отработал');

  // PaddleOCR — если модели есть в сборке
  if (fs.existsSync(path.join(dist, 'lib/models/det.onnx'))) {
    await popup.click('.tabs button[data-tab="settings"]');
    await popup.selectOption('#engine', 'paddle');
    await popup.click('.tabs button[data-tab="queue"]');
    await popup.waitForTimeout(300);
    await popup.click('.card [data-act="redo"]');
    await popup.waitForFunction(() => /Paddle/.test(document.querySelector('.card .sub')?.textContent ?? '') &&
      document.getElementById('pill')?.textContent === 'ожидание', undefined, { timeout: 180000 });
    const pc = await popup.locator('.card').first().innerText();
    console.log('    ' + pc.replace(/\n/g, ' ⏎ '));
    check(/Hello/i.test(pc) && /Привет/i.test(pc), 'PaddleOCR распознал латиницу и кириллицу');
  } else console.log('  – PaddleOCR пропущен: нет моделей (npm run setup)');

  const real = errors.filter((e) => !/Failed to load resource.*models/.test(e));
  check(!real.length, 'нет ошибок в консоли страниц' + (real.length ? ': ' + real.join(' | ') : ''));
} catch (e) {
  fails.push(String(e));
  console.error(e);
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log(fails.length ? `\nПровалено: ${fails.length}` : '\nВсё в порядке');
process.exitCode = fails.length ? 1 : 0;
