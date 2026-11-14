// Минимальный PaddleOCR (PP-OCRv5) поверх onnxruntime-web:
// детекция строк (DB) → распознавание каждой строки (CTC).
// Ограничения: только горизонтальный текст, рамки без поворота.
// onnxruntime-web подключается в engine.html обычным <script> (глобальный `ort`).
import type { InferenceSession } from 'onnxruntime-web';
import {
  CFG, ctcDecode, detInput, detSize, findBoxes, fixSpace, groupLines, joinLines, parseDict, recInput, recWidth,
  scaleBoxes, type Box
} from './paddle-core.ts';

export type Progress = (s: string) => void;
type Canvas2D = HTMLCanvasElement;

const url = (p: string) => chrome.runtime.getURL(p);
const MODELS = { det: 'lib/models/det.onnx', rec: 'lib/models/rec.onnx', dict: 'lib/models/dict.txt' };

let det: InferenceSession | null = null;
let rec: InferenceSession | null = null;
let charset: string[] | null = null;
let spaceChecked = false;

async function fetchBuf(path: string) {
  const r = await fetch(url(path));
  if (!r.ok) throw new Error('Не найден файл ' + path.split('/').slice(-2).join('/') + ' (запустите npm run setup и пересоберите)');
  return r.arrayBuffer();
}

async function init(progress?: Progress) {
  if (det && rec && charset) return;
  if (typeof ort === 'undefined') throw new Error('onnxruntime-web не найден в lib/ort (пересоберите расширение)');
  ort.env.wasm.wasmPaths = url('lib/ort/');
  ort.env.wasm.numThreads = 1;   // без SharedArrayBuffer
  const opts: InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };

  progress?.('PaddleOCR: загрузка модели детекции…');
  det = await ort.InferenceSession.create(new Uint8Array(await fetchBuf(MODELS.det)), opts);
  progress?.('PaddleOCR: загрузка модели распознавания…');
  rec = await ort.InferenceSession.create(new Uint8Array(await fetchBuf(MODELS.rec)), opts);
  charset = parseDict(new TextDecoder().decode(await fetchBuf(MODELS.dict)));
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, ctx: c.getContext('2d', { willReadFrequently: true })! };
}

async function recognizeBox(src: Canvas2D, b: Box) {
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const rh = CFG.recH, rw = recWidth(w, h);
  const { ctx } = canvas(rw, rh);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, rw, rh);
  ctx.drawImage(src, b.x0, b.y0, w, h, 0, 0, rw, rh);
  const input = recInput(ctx.getImageData(0, 0, rw, rh).data, rw, rh);

  const out = await rec!.run({ [rec!.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, rh, rw]) });
  const t = out[rec!.outputNames[0]!]!;
  const [, T, C] = t.dims as number[];
  if (!spaceChecked) { fixSpace(charset!, C!); spaceChecked = true; }
  return ctcDecode(t.data as Float32Array, T!, C!, charset!);
}

export async function recognize(bitmap: ImageBitmap, progress?: Progress) {
  await init(progress);

  // исходник на белом фоне (прозрачные PNG)
  const { c: src, ctx: sctx } = canvas(bitmap.width, bitmap.height);
  sctx.fillStyle = '#fff';
  sctx.fillRect(0, 0, src.width, src.height);
  sctx.drawImage(bitmap, 0, 0);

  progress?.('PaddleOCR: поиск текста…');
  const W = src.width, H = src.height;
  const { rw, rh, sx, sy } = detSize(W, H);
  const { ctx } = canvas(rw, rh);
  ctx.drawImage(src, 0, 0, rw, rh);
  const input = detInput(ctx.getImageData(0, 0, rw, rh).data, rw, rh);
  const dout = await det!.run({ [det!.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, rh, rw]) });
  const prob = dout[det!.outputNames[0]!]!.data as Float32Array;

  const boxes = scaleBoxes(findBoxes(prob, rw, rh), sx, sy, W, H);
  const lines = groupLines(boxes);
  const results = [];
  let done = 0;
  for (const L of lines) {
    const row = [];
    for (const b of L.items) {
      progress?.(`PaddleOCR: распознаю ${++done}/${boxes.length}…`);
      row.push(await recognizeBox(src, b));
    }
    results.push(row);
  }
  return joinLines(results);
}
