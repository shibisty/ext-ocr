// Service worker: контекстное меню, запуск offscreen-движка, keep-awake.
import * as DB from './shared/db.ts';
import { CHANNEL, type BusMessage, type EnsureEngineReply, type RuntimeMessage } from './shared/types.ts';

const ENGINE_URL = chrome.runtime.getURL('engine.html');
let creating: Promise<void> | null = null;

async function engineAlive() {
  const ctx = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType], documentUrls: [ENGINE_URL]
  });
  return ctx.length > 0;
}

/** Запускает фоновый движок (offscreen). Он живёт, пока открыт браузер, даже когда все окна расширения закрыты. */
export async function ensureEngine(): Promise<boolean> {
  if (await engineAlive()) return false;
  creating ??= chrome.offscreen.createDocument({
    url: 'engine.html',
    reasons: ['WORKERS' as chrome.offscreen.Reason],
    justification: 'Фоновое распознавание очереди изображений (Tesseract/ONNX в воркерах)'
  }).finally(() => { creating = null; });
  await creating;
  return true;
}

/** После запуска браузера / обновления расширения — продолжаем очередь, если в ней что-то осталось. */
export async function resumeIfPending() {
  try { if (await DB.countPending()) await ensureEngine(); } catch (e) { console.error(e); }
}

/** Имя файла для картинки из контекстного меню. */
export function webImageName(srcUrl: string, now = Date.now()) {
  const last = decodeURIComponent(srcUrl.split('?')[0]!.split('/').pop() || 'image').slice(0, 60);
  return `web-${now}-${last || 'image'}`;
}

chrome.runtime.onStartup.addListener(resumeIfPending);
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'ocr-image', title: 'Распознать текст на картинке', contexts: ['image'] });
  void resumeIfPending();
});

chrome.runtime.onMessage.addListener((m: RuntimeMessage | undefined, _sender, respond: (r: EnsureEngineReply) => void) => {
  if (m && m.t === 'ensureEngine') {
    ensureEngine().then(() => respond({ ok: true }), (e: Error) => respond({ ok: false, error: e.message }));
    return true;
  }
  if (m && m.t === 'awake') {
    try { if (m.on) chrome.power.requestKeepAwake('system'); else chrome.power.releaseKeepAwake(); } catch { /* нет API */ }
  }
  return undefined;
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ocr-image' || !info.srcUrl) return;
  // панель нужно открыть сразу, пока действует жест пользователя
  let panel = false;
  try { await chrome.sidePanel.open({ tabId: tab!.id! }); panel = true; } catch { /* нет вкладки/API */ }
  try {
    const blob = await (await fetch(info.srcUrl)).blob();
    const name = webImageName(info.srcUrl);
    const file = new File([blob], name, { type: blob.type || 'image/png' });
    await DB.enqueue([{ file, path: name }], { jobName: 'Из контекстного меню' });
    await ensureEngine();
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage({ t: 'reload' } satisfies BusMessage);
    bc.postMessage({ t: 'cmd', cmd: 'wake' } satisfies BusMessage);
    setTimeout(() => bc.close(), 500);
  } catch (e) {
    console.error('context menu', e);
  }
  if (!panel) void chrome.tabs.create({ url: chrome.runtime.getURL('ocr.html') });
});
