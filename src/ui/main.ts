// Общий интерфейс для попапа, боковой панели и полной вкладки. Сам ничего не распознаёт:
// читает IndexedDB и общается с фоновым движком (engine/host.ts) через BroadcastChannel.
import './ui.css';
import * as DB from '../shared/db.ts';
import * as Tr from '../shared/translate.ts';
import * as XLSX from '../shared/xlsx.ts';
import {
  CHANNEL, type BusMessage, type CommandArgs, type CommandName, type EngineState, type EngineSetting, type Entry,
  type Item, type Job, type NeedInfo, type Settings
} from '../shared/types.ts';
import {
  cardHtml, counts, EXPORT_WIDTHS, exportFileName, exportRows, filterItems, fmtDur, historyHtml, isImage,
  jobNameFor, jobOptionsHtml, natural, pageSize, pillClass, pillText, sortItems
} from './format.ts';

type Tab = 'queue' | 'history' | 'settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $in = (id: string) => $<HTMLInputElement>(id);
const $sel = (id: string) => $<HTMLSelectElement>(id);
const $btn = (id: string) => $<HTMLButtonElement>(id);

const MODE = document.body.dataset.mode;
const PAGE_SIZE = pageSize(MODE);

const bc = new BroadcastChannel(CHANNEL);
const post = (m: BusMessage) => bc.postMessage(m);

const S = {
  items: new Map<string, Item>(), jobs: new Map<number, Job>(), E: null as EngineState | null,
  settings: { ...DB.DEFAULTS } as Settings, canTranslateMeta: false,
  tab: 'queue' as Tab, page: 0, jobFilter: 'all', status: '', extraNeed: null as NeedInfo | null,
  prepared: new Set<string>(), localTr: false
};

const errText = (e: unknown) => (e as Error)?.message || String(e);

// ---------- связь с движком ----------
async function ensureEngine() {
  try { await chrome.runtime.sendMessage({ t: 'ensureEngine' }); } catch (e) { console.warn('ensureEngine', e); }
  post({ t: 'hello' });
}
async function command<C extends CommandName>(cmd: C, ...extra: {} extends CommandArgs<C> ? [CommandArgs<C>?] : [CommandArgs<C>]) {
  await ensureEngine();
  post({ t: 'cmd', cmd, ...(extra[0] ?? {}) } as BusMessage);
}
const setStatus = (t: string) => { S.status = t; scheduleRender(); };

bc.onmessage = (e: MessageEvent<BusMessage>) => {
  const m = e.data;
  switch (m.t) {
    case 'item': S.items.set(m.item.key, m.item); scheduleRender(); autoTranslateSoon(); break;
    case 'reload': void reloadAll(); break;
    case 'jobs': void reloadJobs(); break;
    case 'state': S.E = m; scheduleRender(); break;
    case 'toast': setStatus(m.text); break;
    case 'settings': void loadSettings(); break;
  }
};

// ---------- данные ----------
async function reloadAll() {
  const [items, jobs] = await Promise.all([DB.getAllItems(), DB.getJobs()]);
  S.items = new Map(items.map((i) => [i.key, i]));
  S.jobs = new Map(jobs.map((j) => [j.id, j]));
  scheduleRender();
  autoTranslateSoon();
}
async function reloadJobs() {
  S.jobs = new Map((await DB.getJobs()).map((j) => [j.id, j]));
  scheduleRender();
}
async function loadSettings() {
  S.settings = await DB.getSettings();
  S.canTranslateMeta = await DB.getMeta('canTranslate', false);
  $sel('engine').value = S.settings.engine;
  $sel('lang').value = S.settings.lang;
  $in('translate').checked = S.settings.translate;
  $sel('target').value = S.settings.target;
  $in('keepImages').checked = S.settings.keepImages;
  scheduleRender();
}
async function saveSettings() {
  S.settings = {
    engine: $sel('engine').value as EngineSetting, lang: $sel('lang').value, translate: $in('translate').checked,
    target: $sel('target').value, keepImages: $in('keepImages').checked
  };
  await DB.setMeta('settings', S.settings);
  post({ t: 'settings' });
  scheduleRender();
}

const sorted = () => sortItems(S.items.values());

// ---------- добавление ----------
async function addEntries(entries: Entry[]) {
  entries = entries.filter(({ file }) => isImage(file));
  if (!entries.length) { setStatus('Картинок не найдено'); return; }
  entries.sort(natural);
  setStatus('Сохраняю в очередь…');
  try {
    const r = await DB.enqueue(entries, {
      jobName: jobNameFor(entries),
      onProgress: (a, b) => setStatus(`Сохраняю в очередь: ${a}/${b}`)
    });
    setStatus(`Добавлено: ${r.added}` + (r.requeued ? `, повтор ошибок: ${r.requeued}` : '') +
              (r.skipped ? `, уже были: ${r.skipped}` : ''));
  } catch (e) { setStatus('Ошибка сохранения: ' + errText(e)); return; }
  await reloadAll();
  post({ t: 'reload' }); post({ t: 'jobs' });
  void command('wake');
}

async function filesFromDrop(dt: DataTransfer) {
  const out: Entry[] = [], entries: FileSystemEntry[] = [];
  for (const it of dt.items) {              // getAsEntry — только синхронно внутри drop
    if (it.kind !== 'file') continue;
    const en = it.webkitGetAsEntry?.();
    if (en) entries.push(en);
    else { const f = it.getAsFile(); if (f) out.push({ file: f, path: f.name }); }
  }
  const walk = async (en: FileSystemEntry, prefix: string): Promise<void> => {
    if (en.isFile) {
      const file = await new Promise<File>((res, rej) => (en as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: prefix + en.name });
    } else if (en.isDirectory) {
      const reader = (en as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        for (const c of batch) await walk(c, prefix + en.name + '/');
      } while (batch.length);
    }
  };
  for (const en of entries) await walk(en, '');
  return out;
}

// ---------- перевод (запасной вариант, если движок перевести не может) ----------
const engineCanTranslate = () => (S.E ? S.E.canTranslate : S.canTranslateMeta);

let autoTimer: ReturnType<typeof setTimeout> | null = null;
function autoTranslateSoon() {
  if (autoTimer) return;
  autoTimer = setTimeout(() => { autoTimer = null; autoTranslate(); }, 1500);
}
function autoTranslate() {
  if (!S.settings.translate || engineCanTranslate() || !Tr.supported()) return;
  if ([...S.items.values()].some((i) => Tr.needsAuto(i, S.settings.target))) void runLocalTranslate(true);
}
async function runLocalTranslate(auto: boolean) {
  if (!Tr.supported() || S.localTr) return;
  S.localTr = true;
  try {
    await navigator.locks.request('ocr-translate', { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      await Tr.runMissing(S.settings.target, {
        auto,
        post: (m) => { S.items.set(m.item.key, m.item); post(m); scheduleRender(); },
        onProgress: (n, t) => setStatus(`Перевод ${n}/${t}…`)
      });
    });
  } catch (e) { setStatus('Ошибка перевода: ' + errText(e)); }
  finally { S.localTr = false; }
}
function translateMissing() {
  if (engineCanTranslate()) void command('translateMissing');
  else if (Tr.supported()) void runLocalTranslate(false);
  else setStatus('Встроенный перевод недоступен: нужен Chrome 138+ на десктопе');
}

function firstNeed(): NeedInfo | null {
  if (S.extraNeed && !S.prepared.has(S.extraNeed.id)) return S.extraNeed;
  for (const i of S.items.values()) {
    if (i.tState === 'need-download' && i.tNeed && !S.prepared.has(i.tNeed.id)) return i.tNeed;
  }
  return null;
}

// ---------- отрисовка ----------
const filtered = () => filterItems(S.items.values(), { status: $sel('filter').value, query: $in('search').value, job: S.jobFilter });

let jobSig = '';
function renderJobFilter() {
  const jobs = [...S.jobs.values()];
  const sig = jobs.sort((a, b) => b.createdAt - a.createdAt).map((j) => j.id + j.name).join('|') + S.jobFilter;
  if (sig === jobSig) return;
  jobSig = sig;
  $sel('jobFilter').innerHTML = jobOptionsHtml(jobs);
  $sel('jobFilter').value = S.jobFilter;
}

function renderPill() {
  $('pill').textContent = pillText(S.E);
}

function renderQueue() {
  const c = counts(S.items.values()), total = S.items.size, fin = c.done + c.error, left = c.pending + c.processing;
  $('bar').style.width = total ? (fin / total) * 100 + '%' : '0';
  let eta = '';
  if (left && S.E && S.E.sessionDone) eta = ` · осталось ≈ ${fmtDur((S.E.sessionMs / S.E.sessionDone) * left)}`;
  $('stats').textContent = total ? `Всего ${total} · готово ${c.done} · ошибок ${c.error} · в очереди ${left}${eta}` : 'Очередь пуста';
  $('status').textContent = S.E && S.E.current ? `${S.E.current.name}: ${S.E.current.text}` : S.status;

  renderPill();
  $('pill').className = pillClass(S.E);
  $('pause').textContent = S.E && S.E.paused ? 'Продолжить' : 'Пауза';
  $btn('retry').disabled = !c.error;
  $btn('redoAll').disabled = ![...S.items.values()].some((i) => i.hasBlob);
  $btn('export').disabled = !fin;

  const need = firstNeed();
  $('banner').hidden = !need;
  if (need && !$btn('dlBtn').disabled) $('bannerText').textContent = `Для перевода нужно скачать языковой пакет: ${need.label}`;

  if (String(getSelection() ?? '').length) return;   // не мешаем выделять текст
  renderJobFilter();
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  S.page = Math.min(S.page, pages - 1);
  $('list').innerHTML = list.slice(S.page * PAGE_SIZE, (S.page + 1) * PAGE_SIZE)
    .map((i) => cardHtml(i, i.jobId != null ? S.jobs.get(i.jobId) : undefined)).join('');
  $('pager').textContent = `стр. ${S.page + 1} из ${pages} (${list.length})`;
  $btn('prev').disabled = S.page === 0;
  $btn('next').disabled = S.page >= pages - 1;
}

function renderHistory() {
  $('jobs').innerHTML = historyHtml(S.jobs.values(), S.items.values());
}

function renderSettings() {
  $('trNote').textContent = !Tr.supported()
    ? 'Встроенный перевод недоступен: нужен Chrome 138+ на десктопе.'
    : engineCanTranslate() ? 'Перевод выполняется в фоне, локально и бесплатно.'
    : 'В фоне перевод недоступен — он будет выполняться, пока открыто окно расширения.';
  navigator.storage?.estimate?.().then((e) => {
    $('storage').textContent = `Занято хранилищем расширения: ${((e.usage ?? 0) / 1048576).toFixed(1)} МБ`;
  }).catch(() => {});
}

function render() {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  (['queue', 'history', 'settings'] as const).forEach((t) => ($('tab-' + t).hidden = S.tab !== t));
  if (S.tab === 'queue') renderQueue();
  else if (S.tab === 'history') renderHistory();
  else renderSettings();
  // пилюля статуса видна на всех вкладках
  if (S.tab !== 'queue') renderPill();
}
let renderTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRender() {
  if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 200);
}

// ---------- экспорт ----------
function exportXlsx(jobId?: number | string) {
  const rows = exportRows(sorted(), S.jobs, jobId);
  const blob = XLSX.build(rows, { sheetName: 'OCR', widths: EXPORT_WIDTHS });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = exportFileName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  setStatus(`Экспортировано строк: ${rows.length - 1}`);
}

// ---------- события ----------
document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) =>
  (b.onclick = () => { S.tab = b.dataset.tab as Tab; render(); }));

const toEntries = (files: FileList | null) => [...(files ?? [])].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
$btn('btnFiles').onclick = () => $in('file').click();
$btn('btnFolder').onclick = () => $in('folder').click();
const onPick = (e: Event) => {
  const input = e.target as HTMLInputElement;
  void addEntries(toEntries(input.files));
  input.value = '';
};
$in('file').onchange = onPick;
$in('folder').onchange = onPick;

const drop = $('drop');
(['dragenter', 'dragover'] as const).forEach((ev) =>
  document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
(['dragleave', 'drop'] as const).forEach((ev) =>
  document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
document.addEventListener('drop', async (e) => {
  if (!e.dataTransfer) return;
  setStatus('Читаю список файлов…');
  void addEntries(await filesFromDrop(e.dataTransfer));
});
document.addEventListener('paste', (e) => {
  if (!e.clipboardData) return;
  const files = [...e.clipboardData.items].filter((i) => i.type.startsWith('image/'))
    .map((i) => i.getAsFile()).filter((f): f is File => !!f);
  if (!files.length) return;
  void addEntries(files.map((f, n) => {
    const name = `paste-${Date.now()}-${n}.png`;
    return { file: new File([f], name, { type: f.type }), path: name };
  }));
});

$btn('pause').onclick = () => command(S.E && S.E.paused ? 'resume' : 'pause');
$btn('retry').onclick = () => command('retryErrors');
$btn('redoAll').onclick = () => {
  const n = [...S.items.values()].filter((i) => i.hasBlob).length;
  if (confirm(`Переделать все картинки (${n}) заново? Текущие результаты будут заменены.`)) void command('redoAll');
};
$btn('trMissing').onclick = translateMissing;
$btn('export').onclick = () => exportXlsx(S.jobFilter === 'all' ? undefined : S.jobFilter);
$btn('clear').onclick = () => {
  if (confirm('Удалить все результаты, картинки, очередь и историю? Это нельзя отменить.')) void command('clear');
};

$sel('jobFilter').onchange = (e) => { S.jobFilter = (e.target as HTMLSelectElement).value; S.page = 0; render(); };
$sel('filter').onchange = () => { S.page = 0; render(); };
$in('search').oninput = () => { S.page = 0; scheduleRender(); };
$btn('prev').onclick = () => { S.page--; render(); };
$btn('next').onclick = () => { S.page++; render(); };

$('list').addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  const txt = target.closest('.txt');
  if (txt) { txt.classList.toggle('open'); return; }
  const btn = target.closest<HTMLElement>('[data-act]');
  const card = target.closest<HTMLElement>('.card');
  if (!btn || !card) return;
  const item = S.items.get(card.dataset.key!);
  if (!item) return;
  if (btn.dataset.act === 'redo') void command('redoOne', { key: item.key });
  else if (btn.dataset.act === 'copy') {
    await navigator.clipboard.writeText(item.text + (item.translation ? '\n\n' + item.translation : ''));
    setStatus('Скопировано');
  } else if (btn.dataset.act === 'img') {
    const blob = await DB.getBlob(item.key);
    if (blob) window.open(URL.createObjectURL(blob));
    else setStatus('Картинка не сохранена');
  }
});

$('jobs').addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const btn = target.closest<HTMLElement>('[data-jact]');
  const el = target.closest<HTMLElement>('.job');
  if (!btn || !el) return;
  const raw = el.dataset.job!;
  const id = raw === 'none' ? raw : Number(raw);
  switch (btn.dataset.jact) {
    case 'show': S.jobFilter = String(id); S.tab = 'queue'; S.page = 0; render(); break;
    case 'export': exportXlsx(id); break;
    case 'redo':
      if (typeof id === 'number' && confirm('Переделать все картинки этого задания? Текущие результаты будут заменены.')) {
        void command('redoAll', { jobId: id });
      }
      break;
    case 'delete':
      if (typeof id === 'number' && confirm('Удалить задание вместе с результатами и картинками?')) void command('deleteJob', { jobId: id });
      break;
  }
});

$btn('dlBtn').onclick = async () => {
  const need = firstNeed();
  if (!need) return;
  $btn('dlBtn').disabled = true;
  try {
    // create() вызывается прямо в обработчике клика — иначе Chrome откажет без user activation
    await Tr.prepare(need.spec, (p) => ($('bannerText').textContent = `Загрузка ${need.label}: ${Math.round(p * 100)}%`));
    S.prepared.add(need.id);
    S.extraNeed = null;
  } catch (e) {
    $('bannerText').textContent = `Не удалось скачать ${need.label}: ${errText(e)}`;
    $btn('dlBtn').disabled = false;
    return;
  }
  $btn('dlBtn').disabled = false;
  translateMissing();
  scheduleRender();
};

['engine', 'lang', 'target', 'keepImages'].forEach((id) => ($(id).onchange = saveSettings));
$in('translate').onchange = async () => {
  if ($in('translate').checked && !Tr.supported()) {
    $in('translate').checked = false;
    setStatus('Встроенный перевод недоступен: нужен Chrome 138+ на десктопе');
  }
  await saveSettings();
  if (!$in('translate').checked) return;
  try { await Tr.warmup(); }   // внутри клика можно скачать модель определения языка
  catch (e) { if (e instanceof Tr.NeedDownload) S.extraNeed = { id: e.id, label: e.label, spec: e.spec }; }
  if (engineCanTranslate()) void command('translateMissing'); else autoTranslate();
  scheduleRender();
};
$btn('dropBlobs').onclick = async () => {
  if (!confirm('Удалить сохранённые картинки у готовых записей? Результаты останутся, но «Переделать» для них станет недоступно.')) return;
  const n = await DB.dropBlobs();
  setStatus(`Освобождено картинок: ${n}`);
  await reloadAll();
  post({ t: 'reload' });
};

$btn('openTab').onclick = () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('ocr.html') });
  if (MODE === 'popup') window.close();
};
$btn('openPanel').onclick = async () => {
  try {
    const w = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: w.id! });
    window.close();
  } catch (e) { setStatus('Не удалось открыть панель: ' + errText(e)); }
};

// ---------- старт ----------
export const ready = (async () => {
  await loadSettings();
  await reloadAll();
  const pending = [...S.items.values()].some((i) => i.status === 'pending' || i.status === 'processing');
  if (pending) await ensureEngine();           // очередь не пуста — гарантируем, что движок работает
  else post({ t: 'hello' });
  render();
})();

/** Для тестов. */
export const _state = S;
