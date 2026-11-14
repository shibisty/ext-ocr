// Оркестрация движков: Tesseract (с предобработкой) и PaddleOCR (paddle.ts).
// tesseract.js подключается в engine.html обычным <script> (глобальный `Tesseract`).
import * as Paddle from './paddle.ts';
import type { EngineName, EngineSetting } from '../shared/types.ts';
import type { Worker as TesseractWorker } from 'tesseract.js';

export const GOOD_CONF = 80;

export interface OcrResult { text: string; conf: number }
export interface ProcessResult extends OcrResult { engine: EngineName; warn: string }
export interface ProcessOptions { engine: EngineSetting; lang: string; status?: (s: string) => void }

let worker: TesseractWorker | null = null;
let workerLang: string | null = null;
let onStatus: (s: string) => void = () => {};

async function getWorker(lang: string) {
  if (worker && workerLang === lang) return worker;
  if (worker) { try { await worker.terminate(); } catch { /* уже мёртв */ } worker = null; }
  onStatus('загрузка Tesseract…');
  worker = await Tesseract.createWorker(lang, 1, {
    workerPath: chrome.runtime.getURL('lib/worker.min.js'),
    corePath: chrome.runtime.getURL('lib/core'),
    langPath: chrome.runtime.getURL('lib/lang'),
    workerBlobURL: false,   // blob-воркеры запрещены CSP расширений
    cacheMethod: 'none',    // данные и так лежат локально
    logger: (m) => {
      if (m.status === 'recognizing text') onStatus(`Tesseract ${Math.round(m.progress * 100)}%`);
    }
  });
  workerLang = lang;
  return worker;
}

/** Порог Оцу по гистограмме яркости. */
export function otsuThreshold(gray: ArrayLike<number>): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]!]!++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0, wB = 0, max = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > max) { max = between; thr = t; }
  }
  return thr;
}

/** Мелкое увеличиваем (до 3x), гигантское уменьшаем, чтобы не съесть память на пакетах. */
export const preprocessScale = (width: number) =>
  width < 1600 ? Math.min(3, 1600 / width) : width > 3200 ? 3200 / width : 1;

export type PreMode = 'gray' | 'otsu';

/** RGBA на месте → серое (или ч/б по Оцу). */
export function toGray(d: Uint8ClampedArray, mode: PreMode) {
  const gray = new Uint8Array(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    gray[j] = (0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!) | 0;
  }
  const thr = mode === 'otsu' ? otsuThreshold(gray) : null;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    let v = gray[j]!;
    if (thr !== null) v = v > thr ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
}

function preprocess(bitmap: ImageBitmap, mode: PreMode) {
  const scale = preprocessScale(bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  toGray(img.data, mode);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

async function tesseract(bitmap: ImageBitmap, lang: string): Promise<OcrResult> {
  const w = await getWorker(lang);
  let best: OcrResult | null = null;
  try {
    for (const mode of ['gray', 'otsu'] as const) {
      const { data } = await w.recognize(preprocess(bitmap, mode));
      if (!best || data.confidence > best.conf) best = { text: data.text.trim(), conf: data.confidence };
      if (best.conf >= GOOD_CONF) break;
    }
  } catch (e) {
    // воркер мог упасть — пересоздадим на следующей картинке
    try { await worker?.terminate(); } catch { /* уже мёртв */ }
    worker = null;
    throw e;
  }
  return best!;
}

const msg = (e: unknown) => (e as Error)?.message || String(e);

/** Нужен ли PaddleOCR после попытки Tesseract. */
export const needPaddle = (engine: EngineSetting, t: OcrResult | undefined) =>
  engine === 'paddle' || (engine === 'auto' && (!t || t.conf < GOOD_CONF));

/** Выбор результата: Paddle, если он что-то нашёл и не хуже Tesseract больше чем на 10 пунктов. */
export function choose(t: OcrResult | undefined, p: OcrResult | undefined, errors: string[]): ProcessResult {
  if (!t && !p) throw new Error(errors.join(' | ') || 'Нет результата');
  let pick: EngineName = 'tesseract';
  if (p && (!t || (p.text.trim() && p.conf >= t.conf - 10))) pick = 'paddle';
  return { ...(pick === 'paddle' ? p! : t!), engine: pick, warn: errors.join(' | ') };
}

/** engine: 'auto' | 'paddle' | 'tesseract' */
export async function process(bitmap: ImageBitmap, { engine, lang, status }: ProcessOptions): Promise<ProcessResult> {
  onStatus = status || (() => {});
  const errors: string[] = [];
  let t: OcrResult | undefined, p: OcrResult | undefined;

  if (engine !== 'paddle') {
    try { t = await tesseract(bitmap, lang); }
    catch (e) { errors.push('Tesseract: ' + msg(e)); }
  }
  if (needPaddle(engine, t)) {
    try { p = await Paddle.recognize(bitmap, onStatus); }
    catch (e) { errors.push('PaddleOCR: ' + msg(e)); }
  }
  return choose(t, p, errors);
}
