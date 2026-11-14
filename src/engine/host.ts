// Фоновый движок (offscreen-документ): разбирает очередь из IndexedDB, даже когда все окна расширения закрыты.
// Интерфейсы (попап / панель / вкладка) общаются с ним через BroadcastChannel('ocr').
import * as DB from '../shared/db.ts';
import type { TranslationPatch } from '../shared/translate.ts';
import type { BusMessage, EngineState, Item, Settings } from '../shared/types.ts';
import type { ProcessOptions, ProcessResult } from './ocr-engine.ts';

/** Внешние зависимости движка — подменяются в тестах. */
export interface HostDeps {
  send(m: BusMessage): void;
  /** Подписка на входящие сообщения шины. */
  listen(fn: (m: BusMessage) => void): void;
  decode(blob: Blob): Promise<ImageBitmap>;
  thumb(bitmap: ImageBitmap): string;
  process(bitmap: ImageBitmap, o: ProcessOptions): Promise<ProcessResult>;
  probe(): Promise<boolean>;
  translateRecord(text: string | undefined, target: string): Promise<TranslationPatch>;
  runMissing(target: string, o: { post: (m: BusMessage & { t: 'item' }) => void }): Promise<number>;
  awake(on: boolean): void;
  now?: () => number;
}

export interface Host {
  readonly E: Readonly<EngineState> & { queue: readonly string[]; epoch: number; translating: boolean };
  /** Обработка входящего сообщения (то же, что приходит из шины). */
  handle(m: BusMessage): Promise<void>;
  /** Дождаться, пока цикл обработки опустеет (для тестов). */
  idle(): Promise<void>;
  ready: Promise<void>;
}

export function createHost(deps: HostDeps): Host {
  const { send } = deps;
  const perf = deps.now ?? (() => performance.now());

  const E = {
    paused: false, running: false, current: null as EngineState['current'], queue: [] as string[], epoch: 0,
    sessionDone: 0, sessionMs: 0, canTranslate: false, translating: false, remaining: 0
  };

  let lastState = 0;
  function state(force?: boolean) {
    const now = Date.now();
    if (!force && now - lastState < 200) return;
    lastState = now;
    send({ t: 'state', paused: E.paused, running: E.running, current: E.current, remaining: E.queue.length,
      sessionDone: E.sessionDone, sessionMs: E.sessionMs, canTranslate: E.canTranslate });
  }

  async function refreshQueue() {
    const pend = await DB.pendingItems();
    pend.sort((a, b) => (b.prio || 0) - (a.prio || 0) || a.seq - b.seq);
    E.queue = pend.map((p) => p.key);
  }

  let loopDone: Promise<void> = Promise.resolve();
  let rerun: ReturnType<typeof setTimeout> | null = null;

  function loop(): Promise<void> {
    if (E.running) return loopDone;
    E.running = true;
    loopDone = runLoop();
    return loopDone;
  }

  async function runLoop() {
    let processed = 0;
    try {
      await refreshQueue();
      while (!E.paused) {
        const key = E.queue.shift();
        if (!key) break;
        const item = await DB.getItem(key);
        if (!item || item.status !== 'pending') continue;
        if (!processed) deps.awake(true);
        processed++;
        await processItem(item);
      }
    } catch (e) {
      console.error('loop', e);
    } finally {
      E.running = false;
      E.current = null;
      if (processed) deps.awake(false);
      try {
        if (await DB.finishJobs()) send({ t: 'jobs' });
      } catch { /* база могла быть очищена */ }
      state(true);
      if (!E.paused && E.queue.length) rerun = setTimeout(() => { rerun = null; loop(); }, 0);   // успели добавить во время выхода
    }
  }

  async function processItem(item: Item) {
    const epoch = E.epoch, key = item.key, t0 = perf();
    E.current = { key, name: item.name, text: '…' };
    state(true);

    const rec = await DB.patchItem(key, (r) => { r.status = 'processing'; return r; });
    if (!rec) return;
    send({ t: 'item', item: rec });
    await DB.patchJob(item.jobId, (j) => { if (!j.startedAt) j.startedAt = Date.now(); return j; }).catch(() => {});

    const settings: Settings = await DB.getSettings();
    const result: Partial<Item> = {};
    let bitmap: ImageBitmap | null = null;
    try {
      const blob = await DB.getBlob(key);
      if (!blob) throw new Error('Картинка не сохранена — обработать нельзя');
      bitmap = await deps.decode(blob);
      result.thumb = deps.thumb(bitmap);
      const r = await deps.process(bitmap, {
        engine: settings.engine, lang: settings.lang,
        status: (s) => { if (E.current) E.current.text = s; state(); }
      });
      Object.assign(result, { text: r.text, conf: r.conf, engine: r.engine, warn: r.warn || '', error: '', status: 'done' });
    } catch (e) {
      Object.assign(result, { status: 'error', error: (e as Error)?.message || String(e) });
    } finally {
      bitmap?.close?.();
    }
    if (epoch !== E.epoch) return;   // очередь очистили, пока шла обработка

    if (result.status === 'done' && settings.translate && E.canTranslate) {
      Object.assign(result, await deps.translateRecord(result.text, settings.target));
    }
    result.ms = Math.round(perf() - t0);
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
      await deps.runMissing(s.target, { post: send });
    } finally { E.translating = false; }
  }

  async function redo(filter: (r: Item) => boolean, prio = 0) {
    const r = await DB.resetItems(filter, prio);
    if (r.jobIds.size) await DB.reopenJobs([...r.jobIds]);
    if (r.noBlob) send({ t: 'toast', text: `Пропущено без сохранённой картинки: ${r.noBlob}` });
    send({ t: 'reload' }); send({ t: 'jobs' });
    await refreshQueue();
    if (!E.running) loop();
  }

  async function handle(m: BusMessage) {
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
        case 'redoAll': {
          const jobId = m.jobId;
          await redo((r) => jobId == null || r.jobId === jobId);
          break;
        }
        case 'redoOne': {
          const key = m.key;
          await redo((r) => r.key === key, 1);
          break;
        }
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
      send({ t: 'toast', text: 'Ошибка команды ' + m.cmd + ': ' + ((e as Error)?.message || e) });
    }
  }

  deps.listen((m) => { void handle(m); });

  const ready = (async () => {
    E.canTranslate = await deps.probe();
    await DB.setMeta('canTranslate', E.canTranslate);
    E.paused = !!(await DB.getMeta('paused', false));
    await DB.resetProcessing();
    send({ t: 'reload' });
    state(true);
    loop();
  })();

  async function idle() {
    await ready;
    for (;;) {
      await loopDone;
      await new Promise((r) => setTimeout(r, 0));
      if (!E.running && !rerun) return;
    }
  }

  return { E, handle, idle, ready };
}
