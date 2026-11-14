import { describe, expect, it, vi } from 'vitest';
import * as DB from '../src/shared/db.ts';
import { createHost, type HostDeps } from '../src/engine/host.ts';
import type { BusMessage } from '../src/shared/types.ts';
import { entry, tick } from './helpers/data.ts';

function setup(over: Partial<HostDeps> = {}) {
  const sent: BusMessage[] = [];
  const deps: HostDeps = {
    send: (m) => { sent.push(structuredClone(m)); },
    listen: vi.fn(),
    decode: vi.fn(async (b: Blob) => ({ width: 10, height: 10, close: vi.fn(), name: (b as Blob).size }) as unknown as ImageBitmap),
    thumb: vi.fn(() => 'data:thumb'),
    process: vi.fn(async (_b, o) => { o.status?.('работаю'); return { text: 'TEXT', conf: 88, engine: 'tesseract' as const, warn: '' }; }),
    probe: vi.fn(async () => false),
    translateRecord: vi.fn(async (_t, target) => ({ tTarget: target, tErr: '', tNeed: null, translation: 'ПЕРЕВОД', tState: 'ok' as const, lang: 'en' })),
    runMissing: vi.fn(async () => 0),
    awake: vi.fn(),
    ...over
  };
  const host = createHost(deps);
  const of = <T extends BusMessage['t']>(t: T) => sent.filter((m): m is Extract<BusMessage, { t: T }> => m.t === t);
  return { host, deps, sent, of };
}

const byPath = async () => Object.fromEntries((await DB.getAllItems()).map((i) => [i.path, i]));

describe('host: обработка очереди', () => {
  it('обрабатывает все записи по порядку и закрывает задание', async () => {
    await DB.enqueue([entry('1.png'), entry('2.png'), entry('3.png')], { jobName: 'J' });
    const { host, deps, of } = setup();
    await host.idle();

    const items = await byPath();
    for (const p of ['1.png', '2.png', '3.png']) {
      expect(items[p]).toMatchObject({ status: 'done', text: 'TEXT', conf: 88, engine: 'tesseract', thumb: 'data:thumb', hasBlob: true, error: '' });
      expect(items[p]!.ms).toEqual(expect.any(Number));
      expect(items[p]!.doneAt).toEqual(expect.any(Number));
    }
    const order = vi.mocked(deps.decode).mock.calls.map((c) => (c[0] as Blob).size);
    expect(order).toEqual([5, 5, 5]);
    expect(of('item').map((m) => [m.item.path, m.item.status])).toEqual([
      ['1.png', 'processing'], ['1.png', 'done'], ['2.png', 'processing'], ['2.png', 'done'], ['3.png', 'processing'], ['3.png', 'done']
    ]);
    const [job] = await DB.getJobs();
    expect(job!.startedAt).toEqual(expect.any(Number));
    expect(job!.finishedAt).toEqual(expect.any(Number));
    expect(of('jobs').length).toBeGreaterThan(0);
    expect(deps.awake).toHaveBeenCalledWith(true);
    expect(vi.mocked(deps.awake).mock.calls.at(-1)).toEqual([false]);
    expect(host.E.sessionDone).toBe(3);
    const last = of('state').at(-1)!;
    expect(last).toMatchObject({ running: false, current: null, remaining: 0, sessionDone: 3, canTranslate: false });
    expect(await DB.getMeta('canTranslate')).toBe(false);
  });

  it('передаёт настройки в движок; без keepImages удаляет картинку', async () => {
    await DB.setMeta('settings', { engine: 'paddle', lang: 'ukr+eng', keepImages: false });
    await DB.enqueue([entry('a.png')]);
    const { host, deps } = setup();
    await host.idle();
    expect(vi.mocked(deps.process).mock.calls[0]![1]).toMatchObject({ engine: 'paddle', lang: 'ukr+eng' });
    const [it] = await DB.getAllItems();
    expect(it).toMatchObject({ status: 'done', hasBlob: false });
    expect(await DB.getBlob(it!.key)).toBeNull();
  });

  it('ошибка распознавания и отсутствие картинки → status error', async () => {
    await DB.enqueue([entry('bad.png'), entry('gone.png')]);
    const gone = (await byPath())['gone.png']!;
    await DB.deleteBlob(gone.key);
    const { host } = setup({ process: vi.fn(async () => { throw new Error('сломалось'); }) });
    await host.idle();
    const items = await byPath();
    expect(items['bad.png']).toMatchObject({ status: 'error', error: 'сломалось', hasBlob: true });
    expect(items['gone.png']).toMatchObject({ status: 'error', error: 'Картинка не сохранена — обработать нельзя' });
  });

  it('перевод в движке, если он доступен и включён', async () => {
    await DB.setMeta('settings', { translate: true, target: 'uk' });
    await DB.enqueue([entry('a.png')]);
    const { host, deps } = setup({ probe: vi.fn(async () => true) });
    await host.idle();
    expect(deps.translateRecord).toHaveBeenCalledWith('TEXT', 'uk');
    expect((await DB.getAllItems())[0]).toMatchObject({ translation: 'ПЕРЕВОД', tState: 'ok', lang: 'en' });
  });

  it('без доступного перевода не переводит', async () => {
    await DB.setMeta('settings', { translate: true });
    await DB.enqueue([entry('a.png')]);
    const { host, deps } = setup();
    await host.idle();
    expect(deps.translateRecord).not.toHaveBeenCalled();
  });

  it('при старте возвращает прерванные в очередь и уважает сохранённую паузу', async () => {
    await DB.enqueue([entry('a.png')]);
    const [it] = await DB.getAllItems();
    await DB.patchItem(it!.key, (r) => { r.status = 'processing'; });
    await DB.setMeta('paused', true);
    const { host, deps, of } = setup();
    await host.idle();
    expect(deps.process).not.toHaveBeenCalled();
    expect((await DB.getItem(it!.key))!.status).toBe('pending');
    expect(of('reload')).toHaveLength(1);

    await host.handle({ t: 'cmd', cmd: 'resume' });
    await host.idle();
    expect((await DB.getItem(it!.key))!.status).toBe('done');
    expect(await DB.getMeta('paused')).toBe(false);
  });

  it('приоритет: redoOne идёт раньше остальных', async () => {
    await DB.enqueue([entry('1.png'), entry('2.png'), entry('3.png')]);
    const order: string[] = [];
    const { host } = setup({ decode: vi.fn(async (b: Blob) => { order.push(await b.text()); return { width: 1, height: 1 } as ImageBitmap; }) });
    await host.idle();
    order.length = 0;
    const third = (await byPath())['3.png']!;
    await DB.resetItems(() => true);                     // все снова в очереди
    await host.handle({ t: 'cmd', cmd: 'redoOne', key: third.key });
    await host.idle();
    expect(order).toEqual(['3.png', '1.png', '2.png']);
  });
});

describe('host: команды', () => {
  it('hello → немедленный state', async () => {
    const { host, of } = setup();
    await host.idle();
    const n = of('state').length;
    await host.handle({ t: 'hello' });
    expect(of('state').length).toBe(n + 1);
  });

  it('wake подхватывает новые записи', async () => {
    const { host, deps } = setup();
    await host.idle();
    await DB.enqueue([entry('a.png')]);
    await host.handle({ t: 'cmd', cmd: 'wake' });
    await host.idle();
    expect(deps.process).toHaveBeenCalledTimes(1);
  });

  it('pause останавливает цикл после текущей записи', async () => {
    await DB.enqueue([entry('1.png'), entry('2.png')]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { host, deps } = setup({
      process: vi.fn(async () => { await gate; return { text: 't', conf: 1, engine: 'paddle' as const, warn: '' }; })
    });
    await host.ready;
    await tick(5);
    await host.handle({ t: 'cmd', cmd: 'pause' });
    release();
    await host.idle();
    expect(deps.process).toHaveBeenCalledTimes(1);
    expect(host.E.paused).toBe(true);
    expect(await DB.countPending()).toBe(1);
  });

  it('clear во время обработки: результат не записывается', async () => {
    await DB.enqueue([entry('1.png'), entry('2.png')]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { host, of } = setup({
      process: vi.fn(async () => { await gate; return { text: 't', conf: 1, engine: 'paddle' as const, warn: '' }; })
    });
    await host.ready;
    await tick(5);
    await host.handle({ t: 'cmd', cmd: 'clear' });
    release();
    await host.idle();
    expect(await DB.getAllItems()).toEqual([]);
    expect(of('item').filter((m) => m.item.status === 'done')).toEqual([]);
    expect(host.E.sessionDone).toBe(0);
  });

  it('retryErrors и redoAll по заданию; без картинки — toast', async () => {
    await DB.enqueue([entry('a.png'), entry('b.png')]);
    const fail = vi.fn(async () => { throw new Error('x'); });
    const { host, deps, of } = setup({ process: fail });
    await host.idle();
    const { b } = { b: (await byPath())['b.png']! };
    await DB.patchItem(b.key, (r) => { r.hasBlob = false; });

    vi.mocked(deps.process).mockImplementation(async () => ({ text: 'ok', conf: 1, engine: 'paddle', warn: '' }));
    await host.handle({ t: 'cmd', cmd: 'retryErrors' });
    await host.idle();
    expect(of('toast').map((m) => m.text)).toEqual(['Пропущено без сохранённой картинки: 1']);
    const items = await byPath();
    expect(items['a.png']!.status).toBe('done');
    expect(items['b.png']!.status).toBe('error');

    const jobId = items['a.png']!.jobId!;
    await host.handle({ t: 'cmd', cmd: 'redoAll', jobId: jobId + 1 });   // чужое задание — ничего
    await host.idle();
    expect(deps.process).toHaveBeenCalledTimes(3);
    await host.handle({ t: 'cmd', cmd: 'redoAll', jobId });
    await host.idle();
    expect(deps.process).toHaveBeenCalledTimes(4);
    expect((await DB.getJobs())[0]!.finishedAt).toEqual(expect.any(Number));
  });

  it('deleteJob убирает задание из очереди', async () => {
    const { jobId } = await DB.enqueue([entry('a.png')]);
    await DB.setMeta('paused', true);
    const { host, deps } = setup();
    await host.idle();
    await host.handle({ t: 'cmd', cmd: 'deleteJob', jobId: jobId! });
    await host.handle({ t: 'cmd', cmd: 'resume' });
    await host.idle();
    expect(deps.process).not.toHaveBeenCalled();
    expect(await DB.getJobs()).toEqual([]);
  });

  it('translateMissing вызывает runMissing один раз одновременно', async () => {
    await DB.setMeta('settings', { target: 'de' });
    let release!: () => void;
    const runMissing = vi.fn((_target: string) => new Promise<number>((r) => { release = () => r(0); }));
    const { host } = setup({ runMissing });
    await host.idle();
    const p1 = host.handle({ t: 'cmd', cmd: 'translateMissing' });
    await tick(5);
    await host.handle({ t: 'cmd', cmd: 'translateMissing' });
    release();
    await p1;
    expect(runMissing).toHaveBeenCalledTimes(1);
    expect(runMissing.mock.calls[0]![0]).toBe('de');
  });

  it('ошибка команды → toast', async () => {
    const { host, of } = setup({ runMissing: vi.fn(async () => { throw new Error('нет'); }) });
    await host.idle();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await host.handle({ t: 'cmd', cmd: 'translateMissing' });
    expect(of('toast').at(-1)!.text).toBe('Ошибка команды translateMissing: нет');
  });

  it('подписывается на шину и игнорирует чужие сообщения', async () => {
    let listener!: (m: BusMessage) => void;
    const { host, of } = setup({ listen: (fn) => { listener = fn; } });
    await host.idle();
    const n = of('state').length;
    listener({ t: 'reload' });
    listener({ t: 'hello' });
    await tick(5);
    expect(of('state').length).toBe(n + 1);
  });
});
