// Общее хранилище (IndexedDB v2). Работает в service worker, offscreen-движке и страницах UI.
//  items — записи (лёгкие, без картинок) · blobs — исходные картинки · jobs — история заданий · meta — настройки/счётчики
import type { Entry, Item, Job, Settings } from './types.ts';

type StoreName = 'items' | 'blobs' | 'jobs' | 'meta';

const DB_NAME = 'ocr-ext';
const DB_VERSION = 2;

export const FIELDS = ['key', 'seq', 'jobId', 'name', 'path', 'size', 'status', 'prio', 'hasBlob', 'engine', 'conf', 'text',
  'warn', 'error', 'lang', 'translation', 'tState', 'tTarget', 'tErr', 'tNeed', 'thumb', 'ms', 'doneAt'] as const satisfies readonly (keyof Item)[];

export const DEFAULTS: Readonly<Settings> = Object.freeze({
  engine: 'auto', lang: 'rus+eng', translate: false, target: 'ru', keepImages: true
});

/** Поля, которые сбрасываются при повторной обработке. */
export const RESET = Object.freeze({
  status: 'pending', prio: 0, text: '', conf: null, engine: null, warn: '', error: '', lang: '',
  translation: '', tState: '', tTarget: '', tErr: '', tNeed: null, ms: null, doneAt: null
} as const satisfies Partial<Item>);

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      const items = db.objectStoreNames.contains('items')
        ? r.transaction!.objectStore('items')
        : db.createObjectStore('items', { keyPath: 'key' });
      if (!items.indexNames.contains('status')) items.createIndex('status', 'status');
      if (!items.indexNames.contains('jobId')) items.createIndex('jobId', 'jobId');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => { r.result.close(); dbp = null; };
      resolve(r.result);
    };
    r.onerror = () => reject(r.error);
  });
}

/** Закрыть соединение (для тестов и смены версии). */
export async function close(): Promise<void> {
  const p = dbp;
  dbp = null;
  if (p) (await p.catch(() => null))?.close();
}

const rp = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** Транзакция: fn получает object store'ы в порядке stores. Внутри fn ждать можно только IDB-запросы. */
async function tx<T>(stores: StoreName | StoreName[], mode: IDBTransactionMode,
  fn: (...s: IDBObjectStore[]) => T | Promise<T>): Promise<T> {
  const db = await open();
  const names = ([] as StoreName[]).concat(stores);
  const t = db.transaction(names, mode);
  const done = new Promise<void>((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('transaction aborted'));
  });
  done.catch(() => {});   // если fn упадёт раньше — не оставляем «необработанный» reject
  const out = await fn(...names.map((n) => t.objectStore(n)));
  await done;
  return out;
}

/** Оставить только известные поля (в том же порядке, отсутствующие — undefined). */
export const pick = (o: Partial<Item>): Item =>
  Object.fromEntries(FIELDS.map((f) => [f, o[f]])) as unknown as Item;

// ----- items -----
export const getAllItems = () => tx('items', 'readonly', (s) => rp<Item[]>(s.getAll()));
export const getItem = (key: string) => tx('items', 'readonly', (s) => rp<Item | undefined>(s.get(key)));
export const pendingItems = () => tx('items', 'readonly', (s) => rp<Item[]>(s.index('status').getAll('pending')));

export function countPending(): Promise<number> {
  return tx('items', 'readonly', async (s) =>
    (await rp(s.index('status').count('pending'))) + (await rp(s.index('status').count('processing'))));
}

/** read-modify-write одной записи; null, если записи уже нет (например, очередь очистили) */
export const patchItem = (key: string, fn: (r: Item) => Item | void) => tx('items', 'readwrite', async (s) => {
  const rec = await rp<Item | undefined>(s.get(key));
  if (!rec) return null;
  const out = fn(rec) || rec;
  await rp(s.put(pick(out)));
  return pick(out);
});

/** прерванные «в обработке» после падения/закрытия браузера → снова в очередь */
export const resetProcessing = () => tx('items', 'readwrite', async (s) => {
  const keys = await rp(s.index('status').getAllKeys('processing'));
  for (const k of keys) {
    const r = await rp<Item>(s.get(k));
    r.status = 'pending';
    await rp(s.put(r));
  }
  return keys.length;
});

export interface ResetResult { reset: number; noBlob: number; jobIds: Set<number | null> }

/** сбросить результаты у записей, подходящих под filter */
export const resetItems = (filter: (r: Item) => boolean, prio = 0) => tx('items', 'readwrite', async (s) => {
  const all = await rp<Item[]>(s.getAll());
  const out: ResetResult = { reset: 0, noBlob: 0, jobIds: new Set() };
  for (const r of all) {
    if (r.status === 'processing' || !filter(r)) continue;
    if (!r.hasBlob) { out.noBlob++; continue; }
    await rp(s.put(pick({ ...r, ...RESET, prio })));
    out.reset++;
    out.jobIds.add(r.jobId);
  }
  return out;
});

// ----- blobs -----
export const putBlob = (key: string, blob: Blob) => tx('blobs', 'readwrite', (s) => rp(s.put({ key, blob })));
export const getBlob = (key: string) =>
  tx('blobs', 'readonly', async (s) => (await rp<{ blob: Blob } | undefined>(s.get(key)))?.blob || null);
export const deleteBlob = (key: string) => tx('blobs', 'readwrite', (s) => rp(s.delete(key)));

/** освободить место: удалить картинки у уже обработанных записей */
export const dropBlobs = () => tx(['items', 'blobs'], 'readwrite', async (si, sb) => {
  const all = await rp<Item[]>(si.getAll());
  let n = 0;
  for (const r of all) {
    if ((r.status === 'done' || r.status === 'error') && r.hasBlob) {
      await rp(sb.delete(r.key));
      r.hasBlob = false;
      await rp(si.put(r));
      n++;
    }
  }
  return n;
});

// ----- jobs (история) -----
export const getJobs = () => tx('jobs', 'readonly', (s) => rp<Job[]>(s.getAll()));

export const patchJob = (id: number | null, fn: (j: Job) => Job | void) => tx('jobs', 'readwrite', async (s) => {
  if (id == null) return null;
  const j = await rp<Job | undefined>(s.get(id));
  if (!j) return null;
  await rp(s.put(fn(j) || j));
  return j;
});

export const reopenJobs = (ids: (number | null)[]) => tx('jobs', 'readwrite', async (s) => {
  for (const id of ids) {
    if (id == null) continue;
    const j = await rp<Job | undefined>(s.get(id));
    if (j) { j.finishedAt = null; await rp(s.put(j)); }
  }
});

/** закрыть задания, по которым не осталось работы; true — если что-то изменилось */
export const finishJobs = () => tx(['items', 'jobs'], 'readwrite', async (si, sj) => {
  const open = new Set<number | null>();
  for (const st of ['pending', 'processing']) {
    for (const r of await rp<Item[]>(si.index('status').getAll(st))) open.add(r.jobId);
  }
  let changed = false;
  for (const j of await rp<Job[]>(sj.getAll())) {
    if (!j.finishedAt && !open.has(j.id)) { j.finishedAt = Date.now(); await rp(sj.put(j)); changed = true; }
  }
  return changed;
});

export const deleteJob = (id: number) => tx(['items', 'blobs', 'jobs'], 'readwrite', async (si, sb, sj) => {
  const keys = await rp(si.index('jobId').getAllKeys(id));
  for (const k of keys) { await rp(si.delete(k)); await rp(sb.delete(k)); }
  await rp(sj.delete(id));
  return keys.length;
});

export const clearAll = () => tx(['items', 'blobs', 'jobs'], 'readwrite', async (si, sb, sj) => {
  await Promise.all([rp(si.clear()), rp(sb.clear()), rp(sj.clear())]);
});

// ----- meta / настройки -----
export function getMeta<T>(k: string, def: T): Promise<T>;
export function getMeta<T = unknown>(k: string): Promise<T | null>;
export function getMeta(k: string, def: unknown = null): Promise<unknown> {
  return tx('meta', 'readonly', async (s) => (await rp<{ v: unknown } | undefined>(s.get(k)))?.v ?? def);
}
export const setMeta = (k: string, v: unknown) => tx('meta', 'readwrite', (s) => rp(s.put({ k, v })));

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULTS, ...(await getMeta<Partial<Settings>>('settings', {})) };
}

/** Зарезервировать n порядковых номеров, вернуть первый. */
export const reserveSeq = (n: number) => tx('meta', 'readwrite', async (s) => {
  const cur = (await rp<{ v: number } | undefined>(s.get('seq')))?.v || 0;
  await rp(s.put({ k: 'seq', v: cur + n }));
  return cur + 1;
});

export const itemKey = (e: Entry) => `${e.path}|${e.file.size}|${e.file.lastModified}`;

export interface EnqueueResult { added: number; skipped: number; requeued: number; jobId: number | null }
export interface EnqueueOptions { jobName?: string; onProgress?: (done: number, total: number) => void }

/** Добавить файлы в очередь: создаёт «задание», пишет записи и картинки. */
export async function enqueue(entries: Entry[], { jobName = '', onProgress }: EnqueueOptions = {}): Promise<EnqueueResult> {
  const existing = new Set(await tx('items', 'readonly', (s) => rp(s.getAllKeys())));
  const errKeys = new Set(await tx('items', 'readonly', (s) => rp(s.index('status').getAllKeys('error'))));
  const fresh: { key: string; e: Entry }[] = [];
  const requeue: { key: string; file: File }[] = [];
  let skipped = 0;
  for (const e of entries) {
    const key = itemKey(e);
    if (existing.has(key)) {
      if (errKeys.has(key)) requeue.push({ key, file: e.file }); else skipped++;
    } else {
      existing.add(key);
      fresh.push({ key, e });
    }
  }
  let jobId: number | null = null;
  if (fresh.length) {
    const start = await reserveSeq(fresh.length);
    // id = время создания; два добавления в одну миллисекунду не должны затирать друг друга
    const id = jobId = await tx('jobs', 'readwrite', async (s) => {
      let id = Date.now();
      while (await rp(s.count(id))) id++;
      const job: Job = { id, name: jobName, createdAt: id, total: fresh.length, startedAt: null, finishedAt: null };
      await rp(s.put(job));
      return id;
    });
    for (let i = 0; i < fresh.length; i += 50) {
      const chunk = fresh.slice(i, i + 50);
      await tx(['items', 'blobs'], 'readwrite', (si, sb) => {
        chunk.forEach(({ key, e }, j) => {
          si.put(pick({ key, seq: start + i + j, jobId: id, name: e.file.name, path: e.path, size: e.file.size,
            status: 'pending', prio: 0, hasBlob: true }));
          sb.put({ key, blob: e.file });
        });
      });
      onProgress?.(Math.min(fresh.length, i + 50), fresh.length);
    }
  }
  for (const { key, file } of requeue) {
    await putBlob(key, file);
    await patchItem(key, (r) => Object.assign(r, RESET, { hasBlob: true }));
  }
  return { added: fresh.length, skipped, requeued: requeue.length, jobId };
}
