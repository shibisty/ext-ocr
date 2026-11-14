// Точка входа offscreen-документа engine.html: связывает движок с BroadcastChannel, canvas и chrome.runtime.
import * as Tr from '../shared/translate.ts';
import { CHANNEL, type BusMessage, type RuntimeMessage } from '../shared/types.ts';
import { createHost } from './host.ts';
import * as Engine from './ocr-engine.ts';

const bc = new BroadcastChannel(CHANNEL);

function makeThumb(bitmap: ImageBitmap) {
  const k = 64 / Math.max(bitmap.width, bitmap.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * k));
  c.height = Math.max(1, Math.round(bitmap.height * k));
  c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.6);
}

createHost({
  send: (m) => bc.postMessage(m),
  listen: (fn) => { bc.onmessage = (ev: MessageEvent<BusMessage>) => fn(ev.data); },
  decode: (blob) => createImageBitmap(blob),
  thumb: makeThumb,
  process: Engine.process,
  probe: Tr.probe,
  translateRecord: Tr.translateRecord,
  runMissing: Tr.runMissing,
  awake: (on) => {
    try { chrome.runtime.sendMessage({ t: 'awake', on } satisfies RuntimeMessage).catch(() => {}); } catch { /* SW спит */ }
  }
});
