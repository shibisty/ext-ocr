// @vitest-environment happy-dom
// Интерфейс целиком: старый ui.js и новый main.ts на одних и тех же данных, плюс сценарии нового.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as DB from '../src/shared/db.ts';
import { FakeChannel } from './helpers/bus.ts';
import { installChrome, type FakeChrome } from './helpers/chrome.ts';
import { tick } from './helpers/data.ts';
import type { Item, Job } from '../src/shared/types.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const RENDER = 260;   // scheduleRender = 200 мс

let chrome: FakeChrome;

function mountPage(file: string) {
  const html = read(file);
  const body = html.slice(html.indexOf('<body'), html.indexOf('</body>'));
  const mode = /data-mode="(\w+)"/.exec(body)![1]!;
  document.body.innerHTML = body.replace(/^<body[^>]*>/, '').replace(/<script[\s\S]*?<\/script>/g, '');
  document.body.dataset.mode = mode;
  document.body.className = mode;
}

/** Данные, на которых сравниваем старый и новый интерфейс. */
async function seed() {
  const jobs: Job[] = [
    { id: 1_700_000_000_000, name: 'Сканы', createdAt: 1_700_000_000_000, total: 14, startedAt: 1_700_000_001_000, finishedAt: 1_700_000_100_000 },
    { id: 1_700_000_500_000, name: '', createdAt: 1_700_000_500_000, total: 2, startedAt: null, finishedAt: null }
  ];
  const items: Item[] = [];
  for (let n = 1; n <= 16; n++) {
    const jobId = n <= 14 ? jobs[0]!.id : jobs[1]!.id;
    const st = n % 5 === 0 ? 'error' : n === 15 ? 'pending' : n === 16 ? 'processing' : 'done';
    items.push(DB.pick({
      key: `k${n}`, seq: n, jobId, name: `${n}.png`, path: n < 3 ? `Сканы/<${n}>.png` : `${n}.png`, size: 100 + n, status: st, prio: 0,
      hasBlob: n % 3 !== 0, engine: st === 'done' ? (n % 2 ? 'paddle' : 'tesseract') : null, conf: st === 'done' ? 50 + n * 2.37 : null,
      text: st === 'done' ? `Текст ${n} & "кавычки"` : '', warn: n === 4 ? 'Tesseract: OOM' : '', error: st === 'error' ? `Ошибка <${n}>` : '',
      lang: n === 6 ? 'en' : n === 7 ? 'und' : '', translation: n === 6 ? 'Перевод 6' : '',
      tState: n === 6 ? 'ok' : n === 8 ? 'need-download' : n === 9 ? 'unsupported' : n === 11 ? 'same' : '',
      tTarget: [6, 8, 9, 11].includes(n) ? 'ru' : '', tErr: '',
      tNeed: n === 8 ? { id: 'en>ru', label: 'en → ru', spec: { kind: 'pair', from: 'en', to: 'ru' } } : null,
      thumb: n === 1 ? 'data:image/jpeg;base64,AAAA' : undefined, ms: st === 'done' ? 1000 * n : null, doneAt: st === 'done' ? 1_700_000_000_000 + n * 60_000 : null
    }));
  }
  await DB.setMeta('settings', { engine: 'paddle', lang: 'ukr+eng', translate: false, target: 'de', keepImages: false });
  await DB.setMeta('canTranslate', true);
  // пишем напрямую, чтобы не зависеть от enqueue
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('ocr-ext', 2);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  db.close();
  for (const j of jobs) await DB.patchJob(j.id, () => j).then(async (x) => { if (!x) await putJob(j); });
  for (const it of items) await putItem(it);
  return { items, jobs };
}

async function putJob(j: Job) { await rawPut('jobs', j); }
async function putItem(i: Item) { await rawPut('items', i); }
function rawPut(store: string, v: unknown) {
  return new Promise<void>((res, rej) => {
    const r = indexedDB.open('ocr-ext', 2);
    r.onsuccess = () => {
      const t = r.result.transaction(store, 'readwrite');
      t.objectStore(store).put(v);
      t.oncomplete = () => { r.result.close(); res(); };
      t.onerror = () => rej(t.error);
    };
  });
}

/** Снимок того, что видит пользователь. */
function snapshot() {
  const $ = (id: string) => document.getElementById(id)!;
  const btn = (id: string) => ($(id) as HTMLButtonElement).disabled;
  return {
    list: $('list').innerHTML, stats: $('stats').textContent, status: $('status').textContent, pager: $('pager').textContent,
    pill: $('pill').textContent, pillClass: $('pill').className, jobFilter: $('jobFilter').innerHTML, bar: $('bar').style.width,
    banner: $('banner').hidden, bannerText: $('bannerText').textContent,
    disabled: ['retry', 'redoAll', 'export', 'prev', 'next'].map(btn), pause: $('pause').textContent,
    settings: ['engine', 'lang', 'target'].map((id) => ($(id) as HTMLSelectElement).value)
      .concat(['translate', 'keepImages'].map((id) => String(($(id) as HTMLInputElement).checked)))
  };
}

async function clickTab(tab: string) {
  (document.querySelector(`.tabs button[data-tab="${tab}"]`) as HTMLButtonElement).click();
  await tick(10);
}

async function runLegacy() {
  const src = ['db.js', 'translate.js', 'xlsx.js', 'ui.js'].map((f) => read('legacy/' + f)).join('\n;\n');
  (0, eval)(src);   // как обычные <script> на странице
  await tick(RENDER);
}

async function runNew() {
  vi.resetModules();
  const m = await import('../src/ui/main.ts');
  await m.ready;
  await tick(RENDER);
  return m;
}

/** Сценарий для сравнения: очередь (стр. 1 и 2, фильтр, поиск), история, настройки. */
async function scenario() {
  const out: Record<string, unknown> = {};
  out.queue = snapshot();
  (document.getElementById('next') as HTMLButtonElement).click();
  out.page2 = snapshot();
  const filter = document.getElementById('filter') as HTMLSelectElement;
  filter.value = 'error'; filter.dispatchEvent(new Event('change'));
  out.errors = snapshot();
  filter.value = 'all'; filter.dispatchEvent(new Event('change'));
  const search = document.getElementById('search') as HTMLInputElement;
  search.value = 'кавычки'; search.dispatchEvent(new Event('input'));
  await tick(RENDER);
  out.search = snapshot();
  search.value = ''; search.dispatchEvent(new Event('input'));
  FakeChannel.deliver('ocr', { t: 'state', paused: true, running: false, current: { key: 'k15', name: '15.png', text: 'Tesseract 40%' },
    remaining: 1, sessionDone: 4, sessionMs: 8000, canTranslate: true });
  await tick(RENDER);
  out.engine = snapshot();
  await clickTab('history');
  out.history = document.getElementById('jobs')!.innerHTML;
  out.historyPill = document.getElementById('pill')!.textContent;
  await clickTab('settings');
  out.trNote = document.getElementById('trNote')!.textContent;
  out.hidden = ['tab-queue', 'tab-history', 'tab-settings'].map((id) => document.getElementById(id)!.hidden);
  await clickTab('queue');
  return out;
}

beforeEach(() => {
  FakeChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  chrome = installChrome().chrome;
  vi.stubGlobal('confirm', vi.fn(() => true));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('совпадение со старым интерфейсом', () => {
  for (const page of ['popup.html', 'sidepanel.html', 'ocr.html']) {
    it(page, async () => {
      await seed();
      mountPage('legacy/' + page);
      await runLegacy();
      const legacy = await scenario();
      const legacyPosts = FakeChannel.posted.map((p) => p.data);

      FakeChannel.reset();
      await DB.close();
      mountPage(page);
      await runNew();
      const fresh = await scenario();
      const freshPosts = FakeChannel.posted.map((p) => p.data);

      expect(fresh).toEqual(legacy);
      expect(freshPosts).toEqual(legacyPosts);
      // данные действительно отрисовались
      expect((legacy.queue as { list: string }).list).toContain('Текст 2 &amp; "кавычки"');
      const pages = page === 'popup.html' ? 2 : 1;   // 16 записей: попап по 12, панель по 20, вкладка по 50
      expect((legacy.page2 as { pager: string }).pager).toBe(`стр. ${pages} из ${pages} (16)`);
    });
  }
});

describe('новый интерфейс: сценарии', () => {
  const cmds = () => FakeChannel.posted.map((p) => p.data as { t: string; cmd?: string }).filter((m) => m.t === 'cmd');

  beforeEach(async () => { mountPage('popup.html'); });

  it('пустая очередь: hello без запуска движка, кнопки выключены', async () => {
    await runNew();
    expect(FakeChannel.posted.map((p) => p.data)).toEqual([{ t: 'hello' }]);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    const s = snapshot();
    expect(s.stats).toBe('Очередь пуста');
    expect(s.disabled).toEqual([true, true, true, true, true]);
    expect(s.settings).toEqual(['auto', 'rus+eng', 'ru', 'false', 'true']);
  });

  it('есть работа — при открытии запускается движок', async () => {
    await seed();
    await runNew();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ t: 'ensureEngine' });
  });

  it('добавление файлов через input: фильтр картинок, задание, команды', async () => {
    const m = await runNew();
    const input = document.getElementById('file') as HTMLInputElement;
    const files = [new File(['1'], 'b10.png', { type: 'image/png' }), new File(['2'], 'b2.png', { type: 'image/png' }), new File(['x'], 'notes.txt')];
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new Event('change'));
    await tick(RENDER);
    const items = (await DB.getAllItems()).sort((a, b) => a.seq - b.seq);
    expect(items.map((i) => i.path)).toEqual(['b2.png', 'b10.png']);
    expect((await DB.getJobs())[0]!.name).toBe('2 файлов');
    expect(document.getElementById('status')!.textContent).toBe('Добавлено: 2');
    expect(cmds()).toEqual([{ t: 'cmd', cmd: 'wake' }]);
    expect(m._state.items.size).toBe(2);

    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'a.txt')] });
    input.dispatchEvent(new Event('change'));
    await tick(RENDER);
    expect(document.getElementById('status')!.textContent).toBe('Картинок не найдено');
  });

  it('вставка из буфера', async () => {
    await runNew();
    const ev = new Event('paste') as ClipboardEvent;
    const img = new File(['p'], 'image.png', { type: 'image/png' });
    Object.defineProperty(ev, 'clipboardData', { value: { items: [{ type: 'image/png', getAsFile: () => img }, { type: 'text/plain', getAsFile: () => null }] } });
    document.dispatchEvent(ev);
    await tick(RENDER);
    const [it] = await DB.getAllItems();
    expect(it!.path).toMatch(/^paste-\d+-0\.png$/);
  });

  it('кнопки очереди отправляют команды', async () => {
    await seed();
    await runNew();
    FakeChannel.posted = [];
    for (const id of ['pause', 'retry', 'redoAll', 'clear']) (document.getElementById(id) as HTMLButtonElement).click();
    await tick(20);
    expect(cmds().map((c) => c.cmd)).toEqual(['pause', 'retryErrors', 'redoAll', 'clear']);

    FakeChannel.deliver('ocr', { t: 'state', paused: true, running: false, current: null, remaining: 0, sessionDone: 0, sessionMs: 0, canTranslate: false });
    await tick(RENDER);
    (document.getElementById('pause') as HTMLButtonElement).click();
    await tick(20);
    expect(cmds().at(-1)).toEqual({ t: 'cmd', cmd: 'resume' });
  });

  it('отказ в confirm — команда не уходит', async () => {
    await seed();
    await runNew();
    vi.mocked(confirm).mockReturnValue(false);
    FakeChannel.posted = [];
    (document.getElementById('clear') as HTMLButtonElement).click();
    (document.getElementById('redoAll') as HTMLButtonElement).click();
    await tick(20);
    expect(cmds()).toEqual([]);
  });

  it('карточка: переделать, копировать, раскрыть текст', async () => {
    await seed();
    await runNew();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    FakeChannel.posted = [];
    const card = document.querySelector('.card[data-key="k6"]')!;
    expect((card.querySelector('[data-act="redo"]') as HTMLButtonElement).disabled).toBe(true);   // картинка не сохранена
    (document.querySelector('.card[data-key="k4"] [data-act="redo"]') as HTMLButtonElement).click();
    (card.querySelector('[data-act="copy"]') as HTMLButtonElement).click();
    await tick(20);
    expect(cmds()).toEqual([{ t: 'cmd', cmd: 'redoOne', key: 'k4' }]);
    expect(writeText).toHaveBeenCalledWith('Текст 6 & "кавычки"\n\nПеревод 6');
    const txt = card.querySelector('.txt') as HTMLElement;
    txt.click();
    expect(txt.classList.contains('open')).toBe(true);
  });

  it('сообщение item от движка обновляет карточку', async () => {
    await seed();
    await runNew();
    const it = (await DB.getItem('k15'))!;
    FakeChannel.deliver('ocr', { t: 'item', item: { ...it, status: 'done', text: 'Новый текст', engine: 'paddle', conf: 99 } });
    await tick(RENDER);
    (document.getElementById('next') as HTMLButtonElement).click();
    expect(document.querySelector('.card[data-key="k15"]')!.textContent).toContain('Новый текст');
  });

  it('экспорт: файл .xlsx со строками готовых и ошибок', async () => {
    await seed();
    await runNew();
    const blobs: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => { blobs.push(b); return 'blob:x'; }), revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    (document.getElementById('export') as HTMLButtonElement).click();
    expect(click).toHaveBeenCalled();
    expect(blobs[0]!.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await tick(RENDER);
    expect(document.getElementById('status')!.textContent).toBe('Экспортировано строк: 15');   // 12 готовых + 3 ошибки
  });

  it('история: показать / экспорт / переделать / удалить', async () => {
    const { jobs } = await seed();
    await runNew();
    await clickTab('history');
    FakeChannel.posted = [];
    const job = document.querySelector(`.job[data-job="${jobs[0]!.id}"]`)!;
    (job.querySelector('[data-jact="redo"]') as HTMLButtonElement).click();
    (job.querySelector('[data-jact="delete"]') as HTMLButtonElement).click();
    await tick(20);
    expect(cmds()).toEqual([{ t: 'cmd', cmd: 'redoAll', jobId: jobs[0]!.id }, { t: 'cmd', cmd: 'deleteJob', jobId: jobs[0]!.id }]);
    (job.querySelector('[data-jact="show"]') as HTMLButtonElement).click();
    expect(document.getElementById('tab-queue')!.hidden).toBe(false);
    expect((document.getElementById('jobFilter') as HTMLSelectElement).value).toBe(String(jobs[0]!.id));
    expect(document.getElementById('pager')!.textContent).toBe('стр. 1 из 2 (14)');
  });

  it('настройки сохраняются и рассылаются', async () => {
    await runNew();
    const engine = document.getElementById('engine') as HTMLSelectElement;
    engine.value = 'tesseract';
    engine.dispatchEvent(new Event('change'));
    await tick(20);
    expect((await DB.getSettings()).engine).toBe('tesseract');
    expect(FakeChannel.posted.map((p) => p.data)).toContainEqual({ t: 'settings' });
  });

  it('перевод без Translator API: галочка снимается', async () => {
    await runNew();
    const tr = document.getElementById('translate') as HTMLInputElement;
    tr.checked = true;
    tr.dispatchEvent(new Event('change'));
    await tick(RENDER);
    expect(tr.checked).toBe(false);
    expect((await DB.getSettings()).translate).toBe(false);
    expect(document.getElementById('status')!.textContent).toContain('Chrome 138');
  });

  it('открыть во вкладке / в панели', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    await runNew();
    (document.getElementById('openTab') as HTMLButtonElement).click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://test/ocr.html' });
    (document.getElementById('openPanel') as HTMLButtonElement).click();
    await tick(20);
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
    expect(close).toHaveBeenCalledTimes(2);
  });
});
