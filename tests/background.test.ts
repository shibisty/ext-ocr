import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as DB from '../src/shared/db.ts';
import { installChrome, type FakeChrome } from './helpers/chrome.ts';
import { entry, tick } from './helpers/data.ts';

let chrome: FakeChrome;
let bg: typeof import('../src/background.ts');
let heard: unknown[];
let listener: BroadcastChannel;

beforeEach(async () => {
  vi.resetModules();
  chrome = installChrome().chrome;
  bg = await import('../src/background.ts');
  heard = [];
  listener = new BroadcastChannel('ocr');
  listener.onmessage = (e) => heard.push(e.data);
});
afterEach(() => listener.close());

describe('background', () => {
  it('onInstalled: пункт контекстного меню; пустая очередь — движок не запускается', async () => {
    chrome.runtime.onInstalled.emit();
    await tick(10);
    expect(chrome.contextMenus.create).toHaveBeenCalledWith({ id: 'ocr-image', title: 'Распознать текст на картинке', contexts: ['image'] });
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('onStartup: есть работа — запускает offscreen-движок', async () => {
    await DB.enqueue([entry('a.png')]);
    await chrome.runtime.onStartup.emit()[0];
    expect(chrome.offscreen.createDocument).toHaveBeenCalledWith(expect.objectContaining({ url: 'engine.html', reasons: ['WORKERS'] }));
  });

  it('ensureEngine не создаёт второй документ (живой и параллельные вызовы)', async () => {
    const [a, b] = await Promise.all([bg.ensureEngine(), bg.ensureEngine()]);
    expect([a, b]).toEqual([true, true]);
    expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
    expect(await bg.ensureEngine()).toBe(false);
    expect(chrome.runtime.getContexts).toHaveBeenCalledWith({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: ['chrome-extension://test/engine.html'] });
  });

  it('сообщение ensureEngine отвечает асинхронно; ошибка передаётся', async () => {
    const respond = vi.fn();
    const [ret] = chrome.runtime.onMessage.emit({ t: 'ensureEngine' }, {}, respond);
    expect(ret).toBe(true);
    await tick(5);
    expect(respond).toHaveBeenCalledWith({ ok: true });

    chrome.runtime.getContexts.mockResolvedValueOnce([]);
    chrome.offscreen.createDocument.mockRejectedValueOnce(new Error('нельзя'));
    const r2 = vi.fn();
    chrome.runtime.onMessage.emit({ t: 'ensureEngine' }, {}, r2);
    await tick(5);
    expect(r2).toHaveBeenCalledWith({ ok: false, error: 'нельзя' });
  });

  it('awake включает и выключает keep-awake; прочее игнорирует', () => {
    expect(chrome.runtime.onMessage.emit({ t: 'awake', on: true }, {}, vi.fn())).toEqual([undefined]);
    chrome.runtime.onMessage.emit({ t: 'awake', on: false }, {}, vi.fn());
    chrome.runtime.onMessage.emit(undefined, {}, vi.fn());
    expect(chrome.power.requestKeepAwake).toHaveBeenCalledWith('system');
    expect(chrome.power.releaseKeepAwake).toHaveBeenCalledTimes(1);
  });

  it('webImageName', () => {
    expect(bg.webImageName('https://x.org/a/%D1%84%D0%BE%D1%82%D0%BE.jpg?v=1', 7)).toBe('web-7-фото.jpg');
    expect(bg.webImageName('https://x.org/', 7)).toBe('web-7-image');
    expect(bg.webImageName('https://x.org/' + 'n'.repeat(100), 7)).toBe('web-7-' + 'n'.repeat(60));
  });

  it('контекстное меню: картинка в очередь, панель, движок, оповещение интерфейсов', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['PNG'], { type: 'image/webp' }))));
    await chrome.contextMenus.onClicked.emit({ menuItemId: 'ocr-image', srcUrl: 'https://x.org/pic.webp' }, { id: 3 })[0];
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 3 });
    const items = await DB.getAllItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.path).toMatch(/^web-\d+-pic\.webp$/);
    expect((await DB.getJobs())[0]!.name).toBe('Из контекстного меню');
    expect(chrome.offscreen.createDocument).toHaveBeenCalled();
    await tick(10);
    expect(heard).toEqual([{ t: 'reload' }, { t: 'cmd', cmd: 'wake' }]);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('контекстное меню: панель не открылась → вкладка; другой пункт — игнор', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x')));
    chrome.sidePanel.open.mockRejectedValueOnce(new Error('no'));
    await chrome.contextMenus.onClicked.emit({ menuItemId: 'ocr-image', srcUrl: 'https://x.org/a.png' }, { id: 1 })[0];
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://test/ocr.html' });

    await chrome.contextMenus.onClicked.emit({ menuItemId: 'other', srcUrl: 'x' }, { id: 1 })[0];
    await chrome.contextMenus.onClicked.emit({ menuItemId: 'ocr-image' }, { id: 1 })[0];
    expect(await DB.getAllItems()).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('контекстное меню: картинку не скачать — ошибка в консоль, без падения', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('CORS'); }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await chrome.contextMenus.onClicked.emit({ menuItemId: 'ocr-image', srcUrl: 'https://x.org/a.png' }, { id: 1 })[0];
    expect(err).toHaveBeenCalledWith('context menu', expect.any(Error));
    expect(await DB.getAllItems()).toEqual([]);
    vi.unstubAllGlobals();
  });
});
