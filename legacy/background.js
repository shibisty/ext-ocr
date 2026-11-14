importScripts('db.js');

const ENGINE_URL = chrome.runtime.getURL('engine.html');
let creating = null;

async function engineAlive() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [ENGINE_URL] });
  return ctx.length > 0;
}

/** Запускает фоновый движок (offscreen). Он живёт, пока открыт браузер, даже когда все окна расширения закрыты. */
async function ensureEngine() {
  if (await engineAlive()) return false;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'engine.html',
      reasons: ['WORKERS'],
      justification: 'Фоновое распознавание очереди изображений (Tesseract/ONNX в воркерах)'
    }).finally(() => { creating = null; });
  }
  await creating;
  return true;
}

// после запуска браузера / обновления расширения — продолжаем очередь, если в ней что-то осталось
async function resumeIfPending() {
  try { if (await DB.countPending()) await ensureEngine(); } catch (e) { console.error(e); }
}
chrome.runtime.onStartup.addListener(resumeIfPending);
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'ocr-image', title: 'Распознать текст на картинке', contexts: ['image'] });
  resumeIfPending();
});

chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (m && m.t === 'ensureEngine') {
    ensureEngine().then(() => respond({ ok: true }), (e) => respond({ ok: false, error: e.message }));
    return true;
  }
  if (m && m.t === 'awake') {
    try { m.on ? chrome.power.requestKeepAwake('system') : chrome.power.releaseKeepAwake(); } catch {}
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'ocr-image' || !info.srcUrl) return;
  // панель нужно открыть сразу, пока действует жест пользователя
  let panel = false;
  try { await chrome.sidePanel.open({ tabId: tab.id }); panel = true; } catch {}
  try {
    const blob = await (await fetch(info.srcUrl)).blob();
    const last = decodeURIComponent(info.srcUrl.split('?')[0].split('/').pop() || 'image').slice(0, 60);
    const name = `web-${Date.now()}-${last || 'image'}`;
    const file = new File([blob], name, { type: blob.type || 'image/png' });
    await DB.enqueue([{ file, path: name }], { jobName: 'Из контекстного меню' });
    await ensureEngine();
    const bc = new BroadcastChannel('ocr');
    bc.postMessage({ t: 'reload' });
    bc.postMessage({ t: 'cmd', cmd: 'wake' });
    setTimeout(() => bc.close(), 500);
  } catch (e) {
    console.error('context menu', e);
  }
  if (!panel) chrome.tabs.create({ url: chrome.runtime.getURL('ocr.html') });
});
