// Чистая часть PaddleOCR (PP-OCRv5) без DOM и onnxruntime: размеры, нормализация, поиск рамок, CTC.

export const CFG = {
  detMaxSide: 1280,   // максимум стороны для детектора
  detMaxUpscale: 3,   // мелкие картинки увеличиваем не более чем в 3 раза
  detThresh: 0.3,     // порог бинаризации карты вероятностей
  boxThresh: 0.6,     // минимальная средняя вероятность в рамке
  unclip: 1.5,        // расширение рамок (DB сжимает текстовые области)
  recH: 48,           // высота входа распознавателя (PP-OCRv5)
  maxRecW: 3200
} as const;

export interface Box { x0: number; y0: number; x1: number; y1: number; score?: number }
export interface Line { items: Box[]; cy: number; h: number }
type Pixels = ArrayLike<number>;

/** Размер входа детектора: кратно 32, не больше detMaxSide, увеличение не больше detMaxUpscale. */
export function detSize(W: number, H: number) {
  const ratio = Math.min(CFG.detMaxUpscale, CFG.detMaxSide / Math.max(W, H));
  const rw = Math.max(32, Math.round((W * ratio) / 32) * 32);
  const rh = Math.max(32, Math.round((H * ratio) / 32) * 32);
  return { rw, rh, sx: W / rw, sy: H / rh };
}

// BGR, как в эталонном пайплайне PaddleOCR; mean/std ImageNet
const DET_MEAN = [0.406, 0.456, 0.485], DET_STD = [0.225, 0.224, 0.229];

/** RGBA → тензор CHW (BGR) для детектора. */
export function detInput(px: Pixels, rw: number, rh: number): Float32Array {
  const plane = rw * rh;
  const input = new Float32Array(3 * plane);
  for (let i = 0, j = 0; i < plane; i++, j += 4) {
    input[i] = (px[j + 2]! / 255 - DET_MEAN[0]!) / DET_STD[0]!;
    input[plane + i] = (px[j + 1]! / 255 - DET_MEAN[1]!) / DET_STD[1]!;
    input[2 * plane + i] = (px[j]! / 255 - DET_MEAN[2]!) / DET_STD[2]!;
  }
  return input;
}

/** Связные области на карте вероятностей → рамки (в координатах карты). */
export function findBoxes(prob: Pixels, w: number, h: number): Box[] {
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < bin.length; i++) bin[i] = prob[i]! > CFG.detThresh ? 1 : 0;
  const stack = new Int32Array(w * h);
  const boxes: Box[] = [];

  for (let start = 0; start < bin.length; start++) {
    if (bin[start] !== 1) continue;
    let sp = 0;
    stack[sp++] = start; bin[start] = 2;
    let minx = w, miny = h, maxx = 0, maxy = 0, sum = 0, cnt = 0;
    while (sp) {
      const p = stack[--sp]!;
      const x = p % w, y = (p / w) | 0;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      sum += prob[p]!; cnt++;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const np = ny * w + nx;
          if (bin[np] === 1) { bin[np] = 2; stack[sp++] = np; }
        }
      }
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    if (cnt < 10 || Math.min(bw, bh) < 3 || sum / cnt < CFG.boxThresh) continue;
    const d = (bw * bh * CFG.unclip) / (2 * (bw + bh));
    boxes.push({ x0: minx - d, y0: miny - d, x1: maxx + 1 + d, y1: maxy + 1 + d, score: sum / cnt });
  }
  return boxes;
}

/** Рамки карты → координаты исходника, обрезка по краям, отброс вырожденных. */
export function scaleBoxes(boxes: Box[], sx: number, sy: number, W: number, H: number): Box[] {
  return boxes.map((b) => ({
    x0: Math.max(0, b.x0 * sx), y0: Math.max(0, b.y0 * sy),
    x1: Math.min(W, b.x1 * sx), y1: Math.min(H, b.y1 * sy)
  })).filter((b) => b.x1 - b.x0 > 2 && b.y1 - b.y0 > 2);
}

/** Группировка рамок в строки (сверху вниз), внутри строки — слева направо. Сортирует boxes на месте. */
export function groupLines(boxes: Box[]): Line[] {
  boxes.sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
  const lines: Line[] = [];
  for (const b of boxes) {
    const cy = (b.y0 + b.y1) / 2, h = b.y1 - b.y0;
    const L = lines[lines.length - 1];
    if (L && Math.abs(cy - L.cy) < Math.min(h, L.h) * 0.5) {
      L.items.push(b);
      L.cy = (L.cy * (L.items.length - 1) + cy) / L.items.length;
      L.h = Math.min(L.h, h);
    } else lines.push({ items: [b], cy, h });
  }
  lines.forEach((L) => L.items.sort((a, b) => a.x0 - b.x0));
  return lines;
}

/** Ширина входа распознавателя для рамки w×h. */
export const recWidth = (w: number, h: number) =>
  Math.min(CFG.maxRecW, Math.max(CFG.recH, Math.ceil((CFG.recH * w) / h)));

/** RGBA → тензор CHW (BGR), нормализация в [-1, 1]. */
export function recInput(px: Pixels, rw: number, rh: number): Float32Array {
  const plane = rw * rh;
  const input = new Float32Array(3 * plane);
  for (let i = 0, j = 0; i < plane; i++, j += 4) {
    input[i] = (px[j + 2]! / 255 - 0.5) / 0.5;           // B
    input[plane + i] = (px[j + 1]! / 255 - 0.5) / 0.5;   // G
    input[2 * plane + i] = (px[j]! / 255 - 0.5) / 0.5;   // R
  }
  return input;
}

/** Словарь PaddleOCR → алфавит; индекс 0 = CTC blank. */
export function parseDict(text: string): string[] {
  const lines = text.split('\n').map((s) => s.replace(/\r$/, ''));
  if (lines[lines.length - 1] === '') lines.pop();
  return ['', ...lines];
}

/** В словаре PaddleOCR последним может идти пробел — сверяемся с размером выхода (меняет charset). */
export function fixSpace(charset: string[], classes: number) {
  if (charset.length === classes - 1) charset.push(' ');
}

/** Жадное CTC-декодирование выхода [T, C]. */
export function ctcDecode(d: Pixels, T: number, C: number, charset: readonly string[]) {
  let text = '', prev = -1, sum = 0, n = 0;
  for (let step = 0; step < T; step++) {
    let best = 0, bp = -1;
    const off = step * C;
    for (let k = 0; k < C; k++) if (d[off + k]! > bp) { bp = d[off + k]!; best = k; }
    if (best !== 0 && best !== prev) { text += charset[best] ?? ''; sum += bp; n++; }
    prev = best;
  }
  return { text, conf: n ? (sum / n) * 100 : 0, n };
}

/** Склейка распознанных рамок по строкам; уверенность взвешена числом символов. */
export function joinLines(lines: { text: string; conf: number; n: number }[][]) {
  const outLines: string[] = [];
  let sumConf = 0, sumN = 0;
  for (const L of lines) {
    const parts: string[] = [];
    for (const r of L) {
      if (r.text.trim()) { parts.push(r.text); sumConf += r.conf * r.n; sumN += r.n; }
    }
    if (parts.length) outLines.push(parts.join(' '));
  }
  return { text: outLines.join('\n'), conf: sumN ? sumConf / sumN : 0 };
}
