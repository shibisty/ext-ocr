// Фоновый движок (offscreen-документ): разбирает очередь из IndexedDB, пока открыт хоть что-то или вообще ничего.
// Интерфейсы (попап / панель / вкладка) общаются с ним через BroadcastChannel('ocr').
const bc = new BroadcastChannel('ocr');
const send = (m) => bc.postMessage(m);

const E = {
  paused: false, running: false, current: null, queue: [], epoch: 0,
  sessionDone: 0, sessionMs: 0, canTranslate: false, translating: false
};

let lastState = 0;
function state(force) {
  const now = Date.now();
  if (!force && now - lastState < 200) return;
  lastState = now;
  send({ t: 'state', paused: E.paused, running: E.running, current: E.current, remaining: E.queue.length,
         sessionDone: E.sessionDone, sessionMs: E.sessionMs, canTranslate: E.canTranslate });
}
const awake = (on) => { try { chrome.runtime.sendMessage({ t: 'awake', on }).catch(() => {}); } catch {} };

function makeThumb(bitmap) {
  const k = 64 / Math.max(bitmap.width, bitmap.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * k)); c.height = Math.max(1, Math.round(bitmap.height * k));
  c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.6);
}

async function refreshQueue() {
  const pend = await DB.pendingItems();
  pend.sort((a, b) => (b.prio || 0) - (a.prio || 0) || a.seq - b.seq);
  E.queue = pend.map((p) => p.key);
}

async function loop() {
  if (E.running) return;
  E.running = true;
  let processed = 0;
  try {
    await refreshQueue();
    while (!E.paused) {
      const key = E.queue.shift();
      if (!key) break;
      const item = await DB.getItem(key);
      if (!item || item.status !== 'pending') continue;
      if (!processed) awake(true);
      processed++;
      await processItem(item);
    }
  } catch (e) {
    console.error('loop', e);
  } finally {
    E.running = false;
    E.current = null;
    if (processed) awake(false);
    try {
      if (await DB.finishJobs()) send({ t: 'jobs' });
    } catch {}
    state(true);
    if (!E.paused && E.queue.length) setTimeout(loop, 0);   // успели добавить во время выхода
  }
}

async function processItem(item) {
  const epoch = E.epoch, key = item.key, t0 = performance.now();
  E.current = { key, name: item.name, text: '…' };
  state(true);

  const rec = await DB.patchItem(key, (r) => { r.status = 'processing'; return r; });
  if (!rec) return;
  send({ t: 'item', item: rec });
  await DB.patchJob(item.jobId, (j) => { if (!j.startedAt) j.startedAt = Date.now(); return j; }).catch(() => {});

  const settings = await DB.getSettings();
  const result = {};
  let bitmap = null;
  try {
    const blob = await DB.getBlob(key);
    if (!blob) throw new Error('Картинка не сохранена — обработать нельзя');
    bitmap = await createImageBitmap(blob);
    result.thumb = makeThumb(bitmap);
    const r = await Engine.process(bitmap, {
      engine: settings.engine, lang: settings.lang,
      status: (s) => { if (E.current) E.current.text = s; state(); }
    });
    Object.assign(result, { text: r.text, conf: r.conf, engine: r.engine, warn: r.warn || '', error: '', status: 'done' });
  } catch (e) {
    Object.assign(result, { status: 'error', error: e.message || String(e) });
  } finally {
    if (bitmap && bitmap.close) bitmap.close();
  }
  if (epoch !== E.epoch) return;   // очередь очистили, пока шла обработка

  if (result.status === 'done' && settings.translate && E.canTranslate) {
    Object.assign(result, await Tr.translateRecord(result.text, settings.target));
  }
  result.ms = Math.round(performance.now() - t0);
  result.doneAt = Date.now();
  if (result.status === 'done' && !settings.keepImages) {
    await DB.deleteBlob(key).catch(() => {});
    result.hasBlob = false;
  }
  const saved = await DB.patchItem(key, (r) => Object.assign(r, result));
  if (saved) send({ t: 'item', item: saved });
  E.sessionDone++; E.sessionMs += result.ms;
  state(true);
}

async function translateMissing() {
  if (E.translating) return;
  E.translating = true;
  try {
    const s = await DB.getSettings();
    await Tr.runMissing(s.target, { post: send });
  } finally { E.translating = false; }
}

async function redo(filter, prio = 0) {
  const r = await DB.resetItems(filter, prio);
  if (r.jobIds.size) await DB.reopenJobs([...r.jobIds]);
  if (r.noBlob) send({ t: 'toast', text: `Пропущено без сохранённой картинки: ${r.noBlob}` });
  send({ t: 'reload' }); send({ t: 'jobs' });
  await refreshQueue();
  if (!E.running) loop();
}

bc.onmessage = async (ev) => {
  const m = ev.data;
  if (m.t === 'hello') { state(true); return; }
  if (m.t !== 'cmd') return;
  try {
    switch (m.cmd) {
      case 'wake':
        await refreshQueue();
        if (!E.running) loop();
        break;
      case 'pause':
        E.paused = true; await DB.setMeta('paused', true); state(true);
        break;
      case 'resume':
        E.paused = false; await DB.setMeta('paused', false); state(true); loop();
        break;
      case 'retryErrors':
        await redo((r) => r.status === 'error');
        break;
      case 'redoAll':
        await redo((r) => m.jobId == null || r.jobId === m.jobId);
        break;
      case 'redoOne':
        await redo((r) => r.key === m.key, 1);
        break;
      case 'clear':
        E.epoch++; E.queue = [];
        await DB.clearAll();
        send({ t: 'reload' }); send({ t: 'jobs' }); state(true);
        break;
      case 'deleteJob':
        await DB.deleteJob(m.jobId);
        await refreshQueue();
        send({ t: 'reload' }); send({ t: 'jobs' });
        break;
      case 'translateMissing':
        await translateMissing();
        break;
    }
  } catch (e) {
    console.error('cmd', m.cmd, e);
    send({ t: 'toast', text: 'Ошибка команды ' + m.cmd + ': ' + (e.message || e) });
  }
};

(async () => {
  E.canTranslate = await Tr.probe();
  await DB.setMeta('canTranslate', E.canTranslate);
  E.paused = !!(await DB.getMeta('paused', false));
  await DB.resetProcessing();
  send({ t: 'reload' });
  state(true);
  loop();
})();
