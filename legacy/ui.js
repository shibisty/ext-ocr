// Общий интерфейс для попапа, боковой панели и полной вкладки. Сам ничего не распознаёт:
// читает IndexedDB и общается с фоновым движком (host.js) через BroadcastChannel.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MODE = document.body.dataset.mode;
const PAGE_SIZE = { popup: 12, side: 20, full: 50 }[MODE] || 20;
const IMG_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?|avif)$/i;
const STATUS = { pending: 'В очереди', processing: 'Обработка…', done: 'Готово', error: 'Ошибка' };
const ENGINE = { paddle: 'Paddle', tesseract: 'Tesseract' };

const bc = new BroadcastChannel('ocr');
const S = {
  items: new Map(), jobs: new Map(), E: null, settings: { ...DB.DEFAULTS }, canTranslateMeta: false,
  tab: 'queue', page: 0, jobFilter: 'all', status: '', extraNeed: null, prepared: new Set(), localTr: false
};

// ---------- связь с движком ----------
async function ensureEngine() {
  try { await chrome.runtime.sendMessage({ t: 'ensureEngine' }); } catch (e) { console.warn('ensureEngine', e); }
  bc.postMessage({ t: 'hello' });
}
async function command(cmd, extra = {}) {
  await ensureEngine();
  bc.postMessage({ t: 'cmd', cmd, ...extra });
}
const setStatus = (t) => { S.status = t; scheduleRender(); };

bc.onmessage = (e) => {
  const m = e.data;
  switch (m.t) {
    case 'item': S.items.set(m.item.key, m.item); scheduleRender(); autoTranslateSoon(); break;
    case 'reload': reloadAll(); break;
    case 'jobs': reloadJobs(); break;
    case 'state': S.E = m; scheduleRender(); break;
    case 'toast': setStatus(m.text); break;
    case 'settings': loadSettings(); break;
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
  $('engine').value = S.settings.engine;
  $('lang').value = S.settings.lang;
  $('translate').checked = S.settings.translate;
  $('target').value = S.settings.target;
  $('keepImages').checked = S.settings.keepImages;
  scheduleRender();
}
async function saveSettings() {
  S.settings = {
    engine: $('engine').value, lang: $('lang').value, translate: $('translate').checked,
    target: $('target').value, keepImages: $('keepImages').checked
  };
  await DB.setMeta('settings', S.settings);
  bc.postMessage({ t: 'settings' });
  scheduleRender();
}

const sorted = () => [...S.items.values()].sort((a, b) => a.seq - b.seq);
function counts() {
  const c = { pending: 0, processing: 0, done: 0, error: 0 };
  for (const i of S.items.values()) c[i.status]++;
  return c;
}

// ---------- добавление ----------
const natural = (a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });
function jobNameFor(entries) {
  const tops = new Set(entries.map((e) => (e.path.includes('/') ? e.path.split('/')[0] : '')));
  if (tops.size === 1 && [...tops][0]) return [...tops][0];
  return entries.length === 1 ? entries[0].path : `${entries.length} файлов`;
}

async function addEntries(entries) {
  entries = entries.filter(({ file }) => file.type.startsWith('image/') || IMG_RE.test(file.name));
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
  } catch (e) { setStatus('Ошибка сохранения: ' + (e.message || e)); return; }
  await reloadAll();
  bc.postMessage({ t: 'reload' }); bc.postMessage({ t: 'jobs' });
  command('wake');
}

async function filesFromDrop(dt) {
  const out = [], entries = [];
  for (const it of dt.items) {              // getAsEntry — только синхронно внутри drop
    if (it.kind !== 'file') continue;
    const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
    if (en) entries.push(en);
    else { const f = it.getAsFile(); if (f) out.push({ file: f, path: f.name }); }
  }
  const walk = async (en, prefix) => {
    if (en.isFile) out.push({ file: await new Promise((res, rej) => en.file(res, rej)), path: prefix + en.name });
    else if (en.isDirectory) {
      const reader = en.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const c of batch) await walk(c, prefix + en.name + '/');
      } while (batch.length);
    }
  };
  for (const en of entries) await walk(en, '');
  return out;
}

// ---------- перевод (запасной вариант, если движок перевести не может) ----------
const engineCanTranslate = () => (S.E ? S.E.canTranslate : S.canTranslateMeta);

let autoTimer = null;
function autoTranslateSoon() {
  if (autoTimer) return;
  autoTimer = setTimeout(() => { autoTimer = null; autoTranslate(); }, 1500);
}
function autoTranslate() {
  if (!S.settings.translate || engineCanTranslate() || !Tr.supported()) return;
  if ([...S.items.values()].some((i) => Tr.needsAuto(i, S.settings.target))) runLocalTranslate(true);
}
async function runLocalTranslate(auto) {
  if (!Tr.supported() || S.localTr) return;
  S.localTr = true;
  try {
    await navigator.locks.request('ocr-translate', { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      await Tr.runMissing(S.settings.target, {
        auto,
        post: (m) => { S.items.set(m.item.key, m.item); bc.postMessage(m); scheduleRender(); },
        onProgress: (n, t) => setStatus(`Перевод ${n}/${t}…`)
      });
    });
  } catch (e) { setStatus('Ошибка перевода: ' + (e.message || e)); }
  finally { S.localTr = false; }
}
function translateMissing() {
  if (engineCanTranslate()) command('translateMissing');
  else if (Tr.supported()) runLocalTranslate(false);
  else setStatus('Встроенный перевод недоступен: нужен Chrome 138+ на десктопе');
}

function firstNeed() {
  if (S.extraNeed && !S.prepared.has(S.extraNeed.id)) return S.extraNeed;
  for (const i of S.items.values()) {
    if (i.tState === 'need-download' && i.tNeed && !S.prepared.has(i.tNeed.id)) return i.tNeed;
  }
  return null;
}

// ---------- отрисовка ----------
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' с';
  if (s < 3600) return Math.round(s / 60) + ' мин';
  return Math.floor(s / 3600) + ' ч ' + Math.round((s % 3600) / 60) + ' мин';
};
const fmtDate = (t) => new Date(t).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

function tCell(i) {
  if (i.translation) return esc(i.translation);
  if (i.status !== 'done') return '';
  const m = {
    'need-download': '⏳ ждёт языкового пакета',
    same: i.tTarget ? '— уже на целевом языке' : '',
    unknown: '— язык не определён',
    unsupported: `— пара ${esc(i.lang)} → ${esc(i.tTarget)} не поддерживается`,
    error: esc(i.tErr)
  }[i.tState];
  return m ? `<span class="muted">${m}</span>` : '';
}

function cardHtml(i) {
  const job = S.jobs.get(i.jobId);
  const eng = i.status === 'done' ? ` · ${ENGINE[i.engine] || ''} ${Math.round(i.conf || 0)}%` : '';
  const lang = i.lang && i.lang !== 'und' ? ` · ${esc(i.lang)}` : '';
  const text = i.status === 'error'
    ? `<span class="err">${esc(i.error)}</span>`
    : esc(i.text || '') + (i.warn ? `<div class="warn">${esc(i.warn)}</div>` : '');
  const canRedo = i.hasBlob && i.status !== 'processing';
  return `<article class="card st-${i.status}" data-key="${esc(i.key)}">` +
    (i.thumb ? `<img class="thumb" data-act="img" src="${i.thumb}" alt="" title="Открыть картинку">` : '<div class="thumb"></div>') +
    `<div><div class="fname">${esc(i.path)}</div><div class="sub">№${i.seq} · <span class="stt">${STATUS[i.status]}</span>${eng}${lang}` +
    `${job && job.name ? ' · ' + esc(job.name) : ''}</div></div>` +
    `<div class="cols"><div class="txt">${text}</div><div class="txt">${tCell(i)}</div></div>` +
    `<div class="btns"><button data-act="redo" ${canRedo ? '' : 'disabled title="Картинка не сохранена или обрабатывается"'}>Переделать</button>` +
    `<button data-act="copy" ${i.text ? '' : 'disabled'}>Копировать</button></div></article>`;
}

function filtered() {
  const f = $('filter').value, q = $('search').value.trim().toLowerCase(), jf = S.jobFilter;
  return sorted().filter((i) => (f === 'all' || i.status === f) &&
    (jf === 'all' || String(i.jobId ?? 'none') === jf) &&
    (!q || i.path.toLowerCase().includes(q) || (i.text || '').toLowerCase().includes(q) ||
      (i.translation || '').toLowerCase().includes(q)));
}

let jobSig = '';
function renderJobFilter() {
  const jobs = [...S.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  const sig = jobs.map((j) => j.id + j.name).join('|') + S.jobFilter;
  if (sig === jobSig) return;
  jobSig = sig;
  $('jobFilter').innerHTML = '<option value="all">Все задания</option>' +
    jobs.map((j) => `<option value="${j.id}">${esc(j.name || 'Задание')} · ${fmtDate(j.createdAt)}</option>`).join('');
  $('jobFilter').value = S.jobFilter;
}

function renderQueue() {
  const c = counts(), total = S.items.size, fin = c.done + c.error, left = c.pending + c.processing;
  $('bar').style.width = total ? (fin / total) * 100 + '%' : '0';
  let eta = '';
  if (left && S.E && S.E.sessionDone) eta = ` · осталось ≈ ${fmtDur((S.E.sessionMs / S.E.sessionDone) * left)}`;
  $('stats').textContent = total ? `Всего ${total} · готово ${c.done} · ошибок ${c.error} · в очереди ${left}${eta}` : 'Очередь пуста';
  $('status').textContent = S.E && S.E.current ? `${S.E.current.name}: ${S.E.current.text}` : S.status;

  const E = S.E;
  $('pill').textContent = !E ? 'движок не запущен' : E.paused ? 'пауза' : E.running ? 'обработка' : 'ожидание';
  $('pill').className = 'pill ' + (E && E.paused ? 'pause' : E && E.running ? 'run' : '');
  $('pause').textContent = E && E.paused ? 'Продолжить' : 'Пауза';
  $('retry').disabled = !c.error;
  $('redoAll').disabled = ![...S.items.values()].some((i) => i.hasBlob);
  $('export').disabled = !fin;

  const need = firstNeed();
  $('banner').hidden = !need;
  if (need && !$('dlBtn').disabled) $('bannerText').textContent = `Для перевода нужно скачать языковой пакет: ${need.label}`;

  if (String(getSelection()).length) return;   // не мешаем выделять текст
  renderJobFilter();
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  S.page = Math.min(S.page, pages - 1);
  $('list').innerHTML = list.slice(S.page * PAGE_SIZE, (S.page + 1) * PAGE_SIZE).map(cardHtml).join('');
  $('pager').textContent = `стр. ${S.page + 1} из ${pages} (${list.length})`;
  $('prev').disabled = S.page === 0;
  $('next').disabled = S.page >= pages - 1;
}

function jobStats() {
  const m = new Map();
  for (const i of S.items.values()) {
    const id = i.jobId ?? 'none';
    const s = m.get(id) || { total: 0, done: 0, error: 0, open: 0, ms: 0, noBlob: 0 };
    s.total++;
    if (i.status === 'done') s.done++; else if (i.status === 'error') s.error++; else s.open++;
    s.ms += i.ms || 0;
    if (!i.hasBlob) s.noBlob++;
    m.set(id, s);
  }
  return m;
}

function renderHistory() {
  const stats = jobStats();
  const list = [...S.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  if (stats.has('none')) list.push({ id: 'none', name: 'Без задания (старые записи)', createdAt: 0 });
  if (!list.length) { $('jobs').innerHTML = '<p class="hint">Пока пусто.</p>'; return; }
  $('jobs').innerHTML = list.map((j) => {
    const s = stats.get(j.id) || { total: 0, done: 0, error: 0, open: 0, ms: 0 };
    const real = j.id !== 'none';
    const state = j.finishedAt ? 'завершено' : s.open ? 'в работе' : '';
    const dur = j.startedAt && j.finishedAt ? fmtDur(j.finishedAt - j.startedAt) : s.ms ? '≈ ' + fmtDur(s.ms) : '—';
    return `<div class="job" data-job="${j.id}"><div class="jh"><b>${esc(j.name || 'Задание')}</b>` +
      `<span class="sub">${j.createdAt ? fmtDate(j.createdAt) : ''}</span></div>` +
      `<div class="sub">Файлов ${s.total} · готово ${s.done} · ошибок ${s.error}` +
      `${s.open ? ' · в очереди ' + s.open : ''} · время ${dur}${state ? ' · ' + state : ''}</div>` +
      `<div class="btns"><button data-jact="show">Показать</button><button data-jact="export">Экспорт</button>` +
      (real ? `<button data-jact="redo">Переделать</button><button data-jact="delete" class="danger">Удалить</button>` : '') +
      `</div></div>`;
  }).join('');
}

function renderSettings() {
  $('trNote').textContent = !Tr.supported()
    ? 'Встроенный перевод недоступен: нужен Chrome 138+ на десктопе.'
    : engineCanTranslate() ? 'Перевод выполняется в фоне, локально и бесплатно.'
    : 'В фоне перевод недоступен — он будет выполняться, пока открыто окно расширения.';
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((e) => {
      $('storage').textContent = `Занято хранилищем расширения: ${(e.usage / 1048576).toFixed(1)} МБ`;
    }).catch(() => {});
  }
}

function render() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  ['queue', 'history', 'settings'].forEach((t) => ($('tab-' + t).hidden = S.tab !== t));
  if (S.tab === 'queue') renderQueue();
  else if (S.tab === 'history') renderHistory();
  else renderSettings();
  // пилюля статуса видна на всех вкладках
  if (S.tab !== 'queue') {
    const E = S.E;
    $('pill').textContent = !E ? 'движок не запущен' : E.paused ? 'пауза' : E.running ? 'обработка' : 'ожидание';
  }
}
let renderTimer = null;
function scheduleRender() {
  if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 200);
}

// ---------- экспорт ----------
function exportXlsx(jobId) {
  const tLabel = { 'need-download': 'перевод не выполнен: нужен языковой пакет', same: 'уже на целевом языке',
    unknown: 'язык не определён', unsupported: 'пара языков не поддерживается' };
  const rows = [['№', 'Файл', 'Задание', 'Дата', 'Статус', 'Движок', 'Уверенность, %', 'Язык', 'Текст', 'Перевод', 'Примечание']];
  for (const i of sorted()) {
    if (i.status !== 'done' && i.status !== 'error') continue;
    if (jobId !== undefined && String(i.jobId ?? 'none') !== String(jobId)) continue;
    const job = S.jobs.get(i.jobId);
    const notes = [i.error, i.warn, i.tState === 'error' ? 'ошибка перевода: ' + i.tErr : (i.translation ? '' : tLabel[i.tState])]
      .filter(Boolean).join('; ');
    rows.push([i.seq, i.path, job ? job.name : '', i.doneAt ? fmtDate(i.doneAt) : '', STATUS[i.status], ENGINE[i.engine] || '',
      i.conf != null ? Math.round(i.conf * 10) / 10 : '', i.lang && i.lang !== 'und' ? i.lang : '',
      i.text || '', i.translation || '', notes]);
  }
  const blob = XLSX.build(rows, { sheetName: 'OCR', widths: [6, 36, 20, 16, 10, 12, 14, 8, 60, 60, 30] });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ocr-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  setStatus(`Экспортировано строк: ${rows.length - 1}`);
}

// ---------- события ----------
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; render(); }));

const toEntries = (files) => [...files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
$('btnFiles').onclick = () => $('file').click();
$('btnFolder').onclick = () => $('folder').click();
$('file').onchange = (e) => { addEntries(toEntries(e.target.files)); e.target.value = ''; };
$('folder').onchange = (e) => { addEntries(toEntries(e.target.files)); e.target.value = ''; };

const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
document.addEventListener('drop', async (e) => { setStatus('Читаю список файлов…'); addEntries(await filesFromDrop(e.dataTransfer)); });
document.addEventListener('paste', (e) => {
  const files = [...e.clipboardData.items].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile());
  if (!files.length) return;
  addEntries(files.map((f, n) => {
    const name = `paste-${Date.now()}-${n}.png`;
    return { file: new File([f], name, { type: f.type }), path: name };
  }));
});

$('pause').onclick = () => command(S.E && S.E.paused ? 'resume' : 'pause');
$('retry').onclick = () => command('retryErrors');
$('redoAll').onclick = () => {
  const n = [...S.items.values()].filter((i) => i.hasBlob).length;
  if (confirm(`Переделать все картинки (${n}) заново? Текущие результаты будут заменены.`)) command('redoAll');
};
$('trMissing').onclick = translateMissing;
$('export').onclick = () => exportXlsx(S.jobFilter === 'all' ? undefined : S.jobFilter);
$('clear').onclick = () => {
  if (confirm('Удалить все результаты, картинки, очередь и историю? Это нельзя отменить.')) command('clear');
};

$('jobFilter').onchange = (e) => { S.jobFilter = e.target.value; S.page = 0; render(); };
$('filter').onchange = () => { S.page = 0; render(); };
$('search').oninput = () => { S.page = 0; scheduleRender(); };
$('prev').onclick = () => { S.page--; render(); };
$('next').onclick = () => { S.page++; render(); };

$('list').addEventListener('click', async (e) => {
  const txt = e.target.closest('.txt');
  if (txt) { txt.classList.toggle('open'); return; }
  const btn = e.target.closest('[data-act]');
  const card = e.target.closest('.card');
  if (!btn || !card) return;
  const item = S.items.get(card.dataset.key);
  if (!item) return;
  if (btn.dataset.act === 'redo') command('redoOne', { key: item.key });
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
  const btn = e.target.closest('[data-jact]');
  const el = e.target.closest('.job');
  if (!btn || !el) return;
  const raw = el.dataset.job, id = raw === 'none' ? raw : Number(raw);
  switch (btn.dataset.jact) {
    case 'show': S.jobFilter = String(id); S.tab = 'queue'; S.page = 0; render(); break;
    case 'export': exportXlsx(id); break;
    case 'redo':
      if (confirm('Переделать все картинки этого задания? Текущие результаты будут заменены.')) command('redoAll', { jobId: id });
      break;
    case 'delete':
      if (confirm('Удалить задание вместе с результатами и картинками?')) command('deleteJob', { jobId: id });
      break;
  }
});

$('dlBtn').onclick = async () => {
  const need = firstNeed();
  if (!need) return;
  $('dlBtn').disabled = true;
  try {
    // create() вызывается прямо в обработчике клика — иначе Chrome откажет без user activation
    await Tr.prepare(need.spec, (p) => ($('bannerText').textContent = `Загрузка ${need.label}: ${Math.round(p * 100)}%`));
    S.prepared.add(need.id);
    S.extraNeed = null;
  } catch (e) {
    $('bannerText').textContent = `Не удалось скачать ${need.label}: ${e.message}`;
    $('dlBtn').disabled = false;
    return;
  }
  $('dlBtn').disabled = false;
  translateMissing();
  scheduleRender();
};

['engine', 'lang', 'target', 'keepImages'].forEach((id) => ($(id).onchange = saveSettings));
$('translate').onchange = async () => {
  if ($('translate').checked && !Tr.supported()) {
    $('translate').checked = false;
    setStatus('Встроенный перевод недоступен: нужен Chrome 138+ на десктопе');
  }
  await saveSettings();
  if (!$('translate').checked) return;
  try { await Tr.warmup(); }   // внутри клика можно скачать модель определения языка
  catch (e) { if (e instanceof Tr.NeedDownload) S.extraNeed = { id: e.id, label: e.label, spec: e.spec }; }
  if (engineCanTranslate()) command('translateMissing'); else autoTranslate();
  scheduleRender();
};
$('dropBlobs').onclick = async () => {
  if (!confirm('Удалить сохранённые картинки у готовых записей? Результаты останутся, но «Переделать» для них станет недоступно.')) return;
  const n = await DB.dropBlobs();
  setStatus(`Освобождено картинок: ${n}`);
  await reloadAll();
  bc.postMessage({ t: 'reload' });
};

$('openTab').onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL('ocr.html') }); if (MODE === 'popup') window.close(); };
$('openPanel').onclick = async () => {
  try { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id }); window.close(); }
  catch (e) { setStatus('Не удалось открыть панель: ' + e.message); }
};

// ---------- старт ----------
(async () => {
  await loadSettings();
  await reloadAll();
  const pending = [...S.items.values()].some((i) => i.status === 'pending' || i.status === 'processing');
  if (pending) await ensureEngine();           // очередь не пуста — гарантируем, что движок работает
  else bc.postMessage({ t: 'hello' });
  render();
})();
