import { describe, expect, it, vi } from 'vitest';
import * as DB from '../src/shared/db.ts';
import { entry } from './helpers/data.ts';

const keys = (items: { key: string }[]) => items.map((i) => i.key).sort();

describe('enqueue', () => {
  it('создаёт задание, записи с порядковыми номерами и картинки', async () => {
    const before = Date.now();
    const r = await DB.enqueue([entry('a.png'), entry('b.png')], { jobName: 'Пачка' });
    const id = r.jobId!;
    expect(id).toBeGreaterThanOrEqual(before);
    expect(r).toEqual({ added: 2, skipped: 0, requeued: 0, jobId: id });

    const items = (await DB.getAllItems()).sort((a, b) => a.seq - b.seq);
    expect(items.map((i) => [i.path, i.seq, i.status, i.jobId, i.hasBlob, i.prio])).toEqual([
      ['a.png', 1, 'pending', id, true, 0],
      ['b.png', 2, 'pending', id, true, 0]
    ]);
    expect(Object.keys(items[0]!)).toEqual([...DB.FIELDS]);   // хранятся все поля и в том же порядке
    expect(await DB.getJobs()).toEqual([{ id, name: 'Пачка', createdAt: id, total: 2, startedAt: null, finishedAt: null }]);
    expect(await (await DB.getBlob(items[0]!.key))!.text()).toBe('a.png');
    expect(items[0]!.key).toBe('a.png|5|1700000000000');
  });

  it('номера продолжаются между заданиями', async () => {
    await DB.enqueue([entry('a.png')]);
    await DB.enqueue([entry('b.png'), entry('c.png')]);
    expect((await DB.getAllItems()).map((i) => i.seq).sort()).toEqual([1, 2, 3]);
  });

  it('повторы пропускает, ошибочные — ставит в очередь заново', async () => {
    await DB.enqueue([entry('a.png'), entry('b.png')]);
    const [a] = (await DB.getAllItems()).filter((i) => i.path === 'a.png');
    await DB.patchItem(a!.key, (r) => Object.assign(r, { status: 'error', error: 'x', hasBlob: false }));
    await DB.deleteBlob(a!.key);

    const r = await DB.enqueue([entry('a.png'), entry('b.png'), entry('b.png'), entry('c.png')]);
    expect(r).toMatchObject({ added: 1, skipped: 2, requeued: 1 });
    const back = await DB.getItem(a!.key);
    expect(back).toMatchObject({ status: 'pending', error: '', hasBlob: true });
    expect(await DB.getBlob(a!.key)).not.toBeNull();
  });

  it('два добавления в одну миллисекунду — два разных задания', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(42_000);
    const [a, b] = await Promise.all([DB.enqueue([entry('a.png')], { jobName: 'A' }), DB.enqueue([entry('b.png')], { jobName: 'B' })]);
    expect(new Set([a.jobId, b.jobId]).size).toBe(2);
    expect((await DB.getJobs()).map((j) => j.name).sort()).toEqual(['A', 'B']);
    const items = await DB.getAllItems();
    expect(new Set(items.map((i) => i.jobId))).toEqual(new Set([a.jobId, b.jobId]));
  });

  it('пустое задание не создаётся', async () => {
    await DB.enqueue([entry('a.png')]);
    const r = await DB.enqueue([entry('a.png')]);
    expect(r).toEqual({ added: 0, skipped: 1, requeued: 0, jobId: null });
    expect(await DB.getJobs()).toHaveLength(1);
  });

  it('пишет пачками по 50 и сообщает прогресс', async () => {
    const progress = vi.fn();
    const many = Array.from({ length: 120 }, (_, i) => entry(`dir/${i}.png`));
    await DB.enqueue(many, { onProgress: progress });
    expect(progress.mock.calls).toEqual([[50, 120], [100, 120], [120, 120]]);
    expect(await DB.getAllItems()).toHaveLength(120);
    expect(await DB.countPending()).toBe(120);
  });
});

describe('items', () => {
  it('patchItem отбрасывает лишние поля и возвращает null для удалённой записи', async () => {
    await DB.enqueue([entry('a.png')]);
    const [it] = await DB.getAllItems();
    const saved = await DB.patchItem(it!.key, (r) => Object.assign(r, { text: 'hi', junk: 1 }));
    expect(saved).toMatchObject({ text: 'hi' });
    expect(saved).not.toHaveProperty('junk', 1);
    expect(await DB.getItem(it!.key)).not.toHaveProperty('junk', 1);
    expect(await DB.patchItem('nope', (r) => r)).toBeNull();
  });

  it('resetProcessing возвращает прерванные в очередь', async () => {
    await DB.enqueue([entry('a.png'), entry('b.png')]);
    const [a] = await DB.getAllItems();
    await DB.patchItem(a!.key, (r) => { r.status = 'processing'; });
    expect(await DB.resetProcessing()).toBe(1);
    expect((await DB.pendingItems()).length).toBe(2);
  });

  it('countPending считает и pending, и processing', async () => {
    await DB.enqueue([entry('a.png'), entry('b.png'), entry('c.png')]);
    const [a, b] = await DB.getAllItems();
    await DB.patchItem(a!.key, (r) => { r.status = 'processing'; });
    await DB.patchItem(b!.key, (r) => { r.status = 'done'; });
    expect(await DB.countPending()).toBe(2);
  });

  it('resetItems: сбрасывает результаты, пропускает обрабатываемые и без картинки', async () => {
    await DB.enqueue([entry('a.png'), entry('b.png'), entry('c.png')]);
    const [a, b, c] = (await DB.getAllItems()).sort((x, y) => x.seq - y.seq);
    await DB.patchItem(a!.key, (r) => Object.assign(r, { status: 'done', text: 'A', conf: 90, engine: 'paddle', translation: 'T', tState: 'ok' }));
    await DB.patchItem(b!.key, (r) => Object.assign(r, { status: 'done', hasBlob: false }));
    await DB.patchItem(c!.key, (r) => { r.status = 'processing'; });

    const out = await DB.resetItems(() => true, 1);
    expect(out.reset).toBe(1);
    expect(out.noBlob).toBe(1);
    expect([...out.jobIds]).toEqual([a!.jobId]);
    expect(await DB.getItem(a!.key)).toMatchObject({ ...DB.RESET, prio: 1, hasBlob: true });
    expect(await DB.getItem(c!.key)).toMatchObject({ status: 'processing' });
  });
});

describe('blobs и jobs', () => {
  it('dropBlobs удаляет картинки только у готовых и ошибочных', async () => {
    await DB.enqueue([entry('a.png'), entry('b.png'), entry('c.png')]);
    const [a, b, c] = (await DB.getAllItems()).sort((x, y) => x.seq - y.seq);
    await DB.patchItem(a!.key, (r) => { r.status = 'done'; });
    await DB.patchItem(b!.key, (r) => { r.status = 'error'; });
    expect(await DB.dropBlobs()).toBe(2);
    expect(await DB.getBlob(a!.key)).toBeNull();
    expect(await DB.getBlob(c!.key)).not.toBeNull();
    expect((await DB.getItem(b!.key))!.hasBlob).toBe(false);
  });

  it('finishJobs закрывает задания без оставшейся работы, reopenJobs открывает', async () => {
    const j1 = (await DB.enqueue([entry('a.png')])).jobId!;
    await new Promise((r) => setTimeout(r, 2));
    const j2 = (await DB.enqueue([entry('b.png')])).jobId!;
    const a = (await DB.getAllItems()).find((i) => i.path === 'a.png')!;
    await DB.patchItem(a.key, (r) => { r.status = 'done'; });

    expect(await DB.finishJobs()).toBe(true);
    const fin = Object.fromEntries((await DB.getJobs()).map((j) => [j.id, j.finishedAt]));
    expect(fin[j1]).toEqual(expect.any(Number));
    expect(fin[j2]).toBeNull();
    expect(await DB.finishJobs()).toBe(false);

    await DB.reopenJobs([j1, null]);   // null — старые записи без задания, не должны ломать
    expect((await DB.getJobs()).find((j) => j.id === j1)!.finishedAt).toBeNull();
  });

  it('patchJob: нет задания → null', async () => {
    expect(await DB.patchJob(123, (j) => j)).toBeNull();
    expect(await DB.patchJob(null, (j) => j)).toBeNull();
  });

  it('deleteJob удаляет записи, картинки и само задание', async () => {
    const j1 = (await DB.enqueue([entry('a.png'), entry('b.png')])).jobId!;
    await new Promise((r) => setTimeout(r, 2));
    const j2 = (await DB.enqueue([entry('c.png')])).jobId!;
    const a = (await DB.getAllItems()).find((i) => i.path === 'a.png')!;
    expect(await DB.deleteJob(j1)).toBe(2);
    expect(keys(await DB.getAllItems())).toEqual([expect.stringContaining('c.png')]);
    expect(await DB.getBlob(a.key)).toBeNull();
    expect((await DB.getJobs()).map((j) => j.id)).toEqual([j2]);
  });

  it('clearAll очищает всё, кроме meta', async () => {
    await DB.enqueue([entry('a.png')]);
    await DB.setMeta('paused', true);
    await DB.clearAll();
    expect(await DB.getAllItems()).toEqual([]);
    expect(await DB.getJobs()).toEqual([]);
    expect(await DB.getMeta('paused', false)).toBe(true);
    expect((await DB.enqueue([entry('b.png')])).added).toBe(1);
    expect((await DB.getAllItems())[0]!.seq).toBe(2);   // счётчик номеров не сбрасывается
  });
});

describe('meta', () => {
  it('настройки по умолчанию и слияние', async () => {
    expect(await DB.getSettings()).toEqual(DB.DEFAULTS);
    await DB.setMeta('settings', { engine: 'paddle', translate: true });
    expect(await DB.getSettings()).toEqual({ ...DB.DEFAULTS, engine: 'paddle', translate: true });
  });

  it('getMeta: значение по умолчанию, но сохранённый false/0 возвращается как есть', async () => {
    expect(await DB.getMeta('x')).toBeNull();
    expect(await DB.getMeta('x', 5)).toBe(5);
    await DB.setMeta('x', 0);
    expect(await DB.getMeta('x', 5)).toBe(0);
  });

  it('reserveSeq выдаёт непересекающиеся диапазоны', async () => {
    expect(await DB.reserveSeq(3)).toBe(1);
    expect(await DB.reserveSeq(2)).toBe(4);
    expect(await DB.reserveSeq(1)).toBe(6);
  });
});

describe('обновление схемы', () => {
  it('открывает базу v1 без индексов и сохраняет данные', async () => {
    await new Promise<void>((res, rej) => {
      const r = indexedDB.open('ocr-ext', 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore('items', { keyPath: 'key' });
        s.put({ key: 'old', seq: 1, path: 'old.png', status: 'done', hasBlob: false });
      };
      r.onsuccess = () => { r.result.close(); res(); };
      r.onerror = () => rej(r.error);
    });
    expect(await DB.getAllItems()).toEqual([expect.objectContaining({ key: 'old' })]);
    expect(await DB.countPending()).toBe(0);
    expect(await DB.getJobs()).toEqual([]);
    expect(await DB.getSettings()).toEqual(DB.DEFAULTS);
  });
});
