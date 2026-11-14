// Общее хранилище (IndexedDB v2). Работает в service worker, offscreen-движке и страницах UI.
//  items — записи (лёгкие, без картинок) · blobs — исходные картинки · jobs — история заданий · meta — настройки/счётчики
const DB = (() => {
  const FIELDS = ['key', 'seq', 'jobId', 'name', 'path', 'size', 'status', 'prio', 'hasBlob', 'engine', 'conf', 'text',
                  'warn', 'error', 'lang', 'translation', 'tState', 'tTarget', 'tErr', 'tNeed', 'thumb', 'ms', 'doneAt'];
  const DEFAULTS = { engine: 'auto', lang: 'rus+eng', translate: false, target: 'ru', keepImages: true };
  const RESET = { status: 'pending', prio: 0, text: '', conf: null, engine: null, warn: '', error: '', lang: '',
                  translation: '', tState: '', tTarget: '', tErr: '', tNeed: null, ms: null, doneAt: null };
  let dbp = null;

  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    const r = self.indexedDB.open('ocr-ext', 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      const items = db.objectStoreNames.contains('items') ? r.transaction.objectStore('items')
                                                           : db.createObjectStore('items', { keyPath: 'key' });
      if (!items.indexNames.contains('status')) items.createIndex('status', 'status');
      if (!items.indexNames.contains('jobId')) items.createIndex('jobId', 'jobId');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); dbp = null; }; resolve(r.result); };
    r.onerror = () => reject(r.error);
  }));

  const rp = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  /** Транзакция: fn получает object store'ы в порядке stores. Внутри fn ждать можно только IDB-запросы. */
  async function tx(stores, mode, fn) {
    const db = await open();
    const names = [].concat(stores);
    const t = db.transaction(names, mode);
    const done = new Promise((res, rej) => {
      t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('transaction aborted'));
    });
    const out = await fn(...names.map((n) => t.objectStore(n)));
    await done;
    return out;
  }

  const pick = (o) => Object.fromEntries(FIELDS.map((f) => [f, o[f]]));

  const api = {
    DEFAULTS, RESET,

    // ----- items -----
    getAllItems: () => tx('items', 'readonly', (s) => rp(s.getAll())),
    getItem: (key) => tx('items', 'readonly', (s) => rp(s.get(key))),
    pendingItems: () => tx('items', 'readonly', (s) => rp(s.index('status').getAll('pending'))),
    async countPending() {
      return tx('items', 'readonly', async (s) =>
        (await rp(s.index('status').count('pending'))) + (await rp(s.index('status').count('processing'))));
    },
    /** read-modify-write одной записи; null, если записи уже нет (например, очередь очистили) */
    patchItem: (key, fn) => tx('items', 'readwrite', async (s) => {
      const rec = await rp(s.get(key));
      if (!rec) return null;
      const out = fn(rec) || rec;
      await rp(s.put(pick(out)));
      return pick(out);
    }),
    /** прерванные «в обработке» после падения/закрытия браузера → снова в очередь */
    resetProcessing: () => tx('items', 'readwrite', async (s) => {
      const keys = await rp(s.index('status').getAllKeys('processing'));
      for (const k of keys) { const r = await rp(s.get(k)); r.status = 'pending'; await rp(s.put(r)); }
      return keys.length;
    }),
    /** сбросить результаты у записей, подходящих под filter; возвращает { reset, noBlob, jobIds } */
    resetItems: (filter, prio = 0) => tx('items', 'readwrite', async (s) => {
      const all = await rp(s.getAll());
      const out = { reset: 0, noBlob: 0, jobIds: new Set() };
      for (const r of all) {
        if (r.status === 'processing' || !filter(r)) continue;
        if (!r.hasBlob) { out.noBlob++; continue; }
        await rp(s.put(pick({ ...r, ...RESET, prio })));
        out.reset++; out.jobIds.add(r.jobId);
      }
      return out;
    }),

    // ----- blobs -----
    putBlob: (key, blob) => tx('blobs', 'readwrite', (s) => rp(s.put({ key, blob }))),
    getBlob: (key) => tx('blobs', 'readonly', async (s) => (await rp(s.get(key)))?.blob || null),
    deleteBlob: (key) => tx('blobs', 'readwrite', (s) => rp(s.delete(key))),
    /** освободить место: удалить картинки у уже обработанных записей */
    dropBlobs: () => tx(['items', 'blobs'], 'readwrite', async (si, sb) => {
      const all = await rp(si.getAll());
      let n = 0;
      for (const r of all) {
        if ((r.status === 'done' || r.status === 'error') && r.hasBlob) {
          await rp(sb.delete(r.key)); r.hasBlob = false; await rp(si.put(r)); n++;
        }
      }
      return n;
    }),

    // ----- jobs (история) -----
    getJobs: () => tx('jobs', 'readonly', (s) => rp(s.getAll())),
    patchJob: (id, fn) => tx('jobs', 'readwrite', async (s) => {
      const j = await rp(s.get(id));
      if (!j) return null;
      await rp(s.put(fn(j) || j));
      return j;
    }),
    reopenJobs: (ids) => tx('jobs', 'readwrite', async (s) => {
      for (const id of ids) { const j = await rp(s.get(id)); if (j) { j.finishedAt = null; await rp(s.put(j)); } }
    }),
    /** закрыть задания, по которым не осталось работы; true — если что-то изменилось */
    finishJobs: () => tx(['items', 'jobs'], 'readwrite', async (si, sj) => {
      const open = new Set();
      for (const st of ['pending', 'processing']) for (const r of await rp(si.index('status').getAll(st))) open.add(r.jobId);
      let changed = false;
      for (const j of await rp(sj.getAll())) {
        if (!j.finishedAt && !open.has(j.id)) { j.finishedAt = Date.now(); await rp(sj.put(j)); changed = true; }
      }
      return changed;
    }),
    deleteJob: (id) => tx(['items', 'blobs', 'jobs'], 'readwrite', async (si, sb, sj) => {
      const keys = await rp(si.index('jobId').getAllKeys(id));
      for (const k of keys) { await rp(si.delete(k)); await rp(sb.delete(k)); }
      await rp(sj.delete(id));
      return keys.length;
    }),
    clearAll: () => tx(['items', 'blobs', 'jobs'], 'readwrite', async (si, sb, sj) => {
      await Promise.all([rp(si.clear()), rp(sb.clear()), rp(sj.clear())]);
    }),

    // ----- meta / настройки -----
    getMeta: (k, def = null) => tx('meta', 'readonly', async (s) => (await rp(s.get(k)))?.v ?? def),
    setMeta: (k, v) => tx('meta', 'readwrite', (s) => rp(s.put({ k, v }))),
    async getSettings() { return { ...DEFAULTS, ...(await api.getMeta('settings', {})) }; },
    reserveSeq: (n) => tx('meta', 'readwrite', async (s) => {
      const cur = (await rp(s.get('seq')))?.v || 0;
      await rp(s.put({ k: 'seq', v: cur + n }));
      return cur + 1;
    }),

    /**
     * Добавить файлы в очередь: создаёт «задание», пишет записи и картинки.
     * entries: [{ file: File, path: string }] → { added, skipped, requeued, jobId }
     */
    async enqueue(entries, { jobName = '', onProgress } = {}) {
      const existing = new Set(await tx('items', 'readonly', (s) => rp(s.getAllKeys())));
      const errKeys = new Set(await tx('items', 'readonly', (s) => rp(s.index('status').getAllKeys('error'))));
      const fresh = [], requeue = [];
      let skipped = 0;
      for (const e of entries) {
        const key = `${e.path}|${e.file.size}|${e.file.lastModified}`;
        if (existing.has(key)) { errKeys.has(key) ? requeue.push({ key, file: e.file }) : skipped++; }
        else { existing.add(key); fresh.push({ key, e }); }
      }
      let jobId = null;
      if (fresh.length) {
        jobId = Date.now();
        const start = await api.reserveSeq(fresh.length);
        await tx('jobs', 'readwrite', (s) => rp(s.put({
          id: jobId, name: jobName, createdAt: jobId, total: fresh.length, startedAt: null, finishedAt: null })));
        for (let i = 0; i < fresh.length; i += 50) {
          const chunk = fresh.slice(i, i + 50);
          await tx(['items', 'blobs'], 'readwrite', (si, sb) => {
            chunk.forEach(({ key, e }, j) => {
              si.put(pick({ key, seq: start + i + j, jobId, name: e.file.name, path: e.path, size: e.file.size,
                            status: 'pending', prio: 0, hasBlob: true }));
              sb.put({ key, blob: e.file });
            });
          });
          onProgress && onProgress(Math.min(fresh.length, i + 50), fresh.length);
        }
      }
      for (const { key, file } of requeue) {
        await api.putBlob(key, file);
        await api.patchItem(key, (r) => Object.assign(r, RESET, { hasBlob: true }));
      }
      return { added: fresh.length, skipped, requeued: requeue.length, jobId };
    }
  };
  return api;
})();
if (typeof module !== 'undefined') module.exports = DB;
