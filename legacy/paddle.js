// Минимальный PaddleOCR (PP-OCRv5) поверх onnxruntime-web:
// детекция строк (DB) → распознавание каждой строки (CTC).
// Ограничения: только горизонтальный текст, рамки без поворота.
(() => {
  const CFG = {
    detUrl: chrome.runtime.getURL('lib/models/det.onnx'),
    recUrl: chrome.runtime.getURL('lib/models/rec.onnx'),
    dictUrl: chrome.runtime.getURL('lib/models/dict.txt'),
    detMaxSide: 1280,   // максимум стороны для детектора
    detMaxUpscale: 3,   // мелкие картинки увеличиваем не более чем в 3 раза
    detThresh: 0.3,     // порог бинаризации карты вероятностей
    boxThresh: 0.6,     // минимальная средняя вероятность в рамке
    unclip: 1.5,        // расширение рамок (DB сжимает текстовые области)
    recH: 48,           // высота входа распознавателя (PP-OCRv5)
    maxRecW: 3200
  };

  let det = null, rec = null, charset = null, spaceChecked = false;

  async function fetchBuf(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('Не найден файл ' + url.split('/').slice(-2).join('/') + ' (запустите npm run setup)');
    return r.arrayBuffer();
  }

  async function init(progress) {
    if (det && rec && charset) return;
    if (typeof ort === 'undefined') throw new Error('onnxruntime-web не найден в lib/ort (запустите npm run setup)');
    ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/ort/');
    ort.env.wasm.numThreads = 1;   // без SharedArrayBuffer
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };

    progress && progress('PaddleOCR: загрузка модели детекции…');
    det = await ort.InferenceSession.create(new Uint8Array(await fetchBuf(CFG.detUrl)), opts);
    progress && progress('PaddleOCR: загрузка модели распознавания…');
    rec = await ort.InferenceSession.create(new Uint8Array(await fetchBuf(CFG.recUrl)), opts);

    const lines = new TextDecoder().decode(await fetchBuf(CFG.dictUrl)).split('\n').map((s) => s.replace(/\r$/, ''));
    if (lines[lines.length - 1] === '') lines.pop();
    charset = ['', ...lines];   // индекс 0 = CTC blank
  }

  // ---------- детекция ----------
  function detect(src) {
    const W = src.width, H = src.height;
    const ratio = Math.min(CFG.detMaxUpscale, CFG.detMaxSide / Math.max(W, H));
    const rw = Math.max(32, Math.round((W * ratio) / 32) * 32);
    const rh = Math.max(32, Math.round((H * ratio) / 32) * 32);

    const c = document.createElement('canvas');
    c.width = rw; c.height = rh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, rw, rh);
    const px = ctx.getImageData(0, 0, rw, rh).data;

    // BGR, как в эталонном пайплайне PaddleOCR; mean/std ImageNet
    const mean = [0.406, 0.456, 0.485], std = [0.225, 0.224, 0.229];
    const plane = rw * rh;
    const input = new Float32Array(3 * plane);
    for (let i = 0, j = 0; i < plane; i++, j += 4) {
      input[i] = (px[j + 2] / 255 - mean[0]) / std[0];
      input[plane + i] = (px[j + 1] / 255 - mean[1]) / std[1];
      input[2 * plane + i] = (px[j] / 255 - mean[2]) / std[2];
    }
    return { input, rw, rh, sx: W / rw, sy: H / rh, W, H };
  }

  function findBoxes(prob, w, h) {
    const bin = new Uint8Array(w * h);
    for (let i = 0; i < bin.length; i++) bin[i] = prob[i] > CFG.detThresh ? 1 : 0;
    const stack = new Int32Array(w * h);
    const boxes = [];

    for (let start = 0; start < bin.length; start++) {
      if (bin[start] !== 1) continue;
      let sp = 0;
      stack[sp++] = start; bin[start] = 2;
      let minx = w, miny = h, maxx = 0, maxy = 0, sum = 0, cnt = 0;
      while (sp) {
        const p = stack[--sp];
        const x = p % w, y = (p / w) | 0;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
        sum += prob[p]; cnt++;
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

  function groupLines(boxes) {
    boxes.sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
    const lines = [];
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

  // ---------- распознавание ----------
  async function recognizeBox(src, b) {
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    const rh = CFG.recH;
    const rw = Math.min(CFG.maxRecW, Math.max(rh, Math.ceil((rh * w) / h)));

    const c = document.createElement('canvas');
    c.width = rw; c.height = rh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, rw, rh);
    ctx.drawImage(src, b.x0, b.y0, w, h, 0, 0, rw, rh);
    const px = ctx.getImageData(0, 0, rw, rh).data;

    const plane = rw * rh;
    const input = new Float32Array(3 * plane);
    for (let i = 0, j = 0; i < plane; i++, j += 4) {
      input[i] = (px[j + 2] / 255 - 0.5) / 0.5;           // B
      input[plane + i] = (px[j + 1] / 255 - 0.5) / 0.5;   // G
      input[2 * plane + i] = (px[j] / 255 - 0.5) / 0.5;   // R
    }
    const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, rh, rw]) });
    const t = out[rec.outputNames[0]];
    const [, T, C] = t.dims;

    // в словаре PaddleOCR последним может идти пробел; сверяемся с размером выхода
    if (!spaceChecked) {
      if (charset.length === C - 1) charset.push(' ');
      spaceChecked = true;
    }

    let text = '', prev = -1, sum = 0, n = 0;
    const d = t.data;
    for (let step = 0; step < T; step++) {
      let best = 0, bp = -1;
      const off = step * C;
      for (let k = 0; k < C; k++) if (d[off + k] > bp) { bp = d[off + k]; best = k; }
      if (best !== 0 && best !== prev) { text += charset[best] ?? ''; sum += bp; n++; }
      prev = best;
    }
    return { text, conf: n ? (sum / n) * 100 : 0, n };
  }

  // ---------- публичный API ----------
  async function recognize(bitmap, progress) {
    await init(progress);

    // исходник на белом фоне (прозрачные PNG)
    const src = document.createElement('canvas');
    src.width = bitmap.width; src.height = bitmap.height;
    const sctx = src.getContext('2d');
    sctx.fillStyle = '#fff';
    sctx.fillRect(0, 0, src.width, src.height);
    sctx.drawImage(bitmap, 0, 0);

    progress && progress('PaddleOCR: поиск текста…');
    const { input, rw, rh, sx, sy, W, H } = detect(src);
    const dout = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, rh, rw]) });
    const prob = dout[det.outputNames[0]].data;

    const boxes = findBoxes(prob, rw, rh).map((b) => ({
      x0: Math.max(0, b.x0 * sx), y0: Math.max(0, b.y0 * sy),
      x1: Math.min(W, b.x1 * sx), y1: Math.min(H, b.y1 * sy)
    })).filter((b) => b.x1 - b.x0 > 2 && b.y1 - b.y0 > 2);

    const lines = groupLines(boxes);
    const outLines = [];
    let sumConf = 0, sumN = 0, done = 0;
    for (const L of lines) {
      const parts = [];
      for (const b of L.items) {
        progress && progress(`PaddleOCR: распознаю ${++done}/${boxes.length}…`);
        const r = await recognizeBox(src, b);
        if (r.text.trim()) { parts.push(r.text); sumConf += r.conf * r.n; sumN += r.n; }
      }
      if (parts.length) outLines.push(parts.join(' '));
    }
    return { text: outLines.join('\n'), conf: sumN ? sumConf / sumN : 0 };
  }

  window.PaddleOCR = { recognize };
})();
