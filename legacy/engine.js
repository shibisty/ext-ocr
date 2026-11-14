// Оркестрация движков: Tesseract (с предобработкой) и PaddleOCR (paddle.js).
const Engine = (() => {
  const GOOD_CONF = 80;
  let worker = null, workerLang = null;
  let onStatus = () => {};

  async function getWorker(lang) {
    if (worker && workerLang === lang) return worker;
    if (worker) { try { await worker.terminate(); } catch {} worker = null; }
    onStatus('загрузка Tesseract…');
    worker = await Tesseract.createWorker(lang, 1, {
      workerPath: chrome.runtime.getURL('lib/worker.min.js'),
      corePath: chrome.runtime.getURL('lib/core'),
      langPath: chrome.runtime.getURL('lib/lang'),
      workerBlobURL: false,
      cacheMethod: 'none',
      logger: (m) => {
        if (m.status === 'recognizing text') onStatus(`Tesseract ${Math.round(m.progress * 100)}%`);
      }
    });
    workerLang = lang;
    return worker;
  }

  function otsuThreshold(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, max = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between > max) { max = between; thr = t; }
    }
    return thr;
  }

  function preprocess(bitmap, mode) {
    // мелкое увеличиваем (до 3x), гигантское уменьшаем, чтобы не съесть память на пакетах
    const scale = bitmap.width < 1600 ? Math.min(3, 1600 / bitmap.width)
                : bitmap.width > 3200 ? 3200 / bitmap.width : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = img.data;
    const gray = new Uint8Array(d.length / 4);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      gray[j] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
    }
    const thr = mode === 'otsu' ? otsuThreshold(gray) : null;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      let v = gray[j];
      if (thr !== null) v = v > thr ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  async function tesseract(bitmap, lang) {
    const w = await getWorker(lang);
    let best = null;
    try {
      for (const mode of ['gray', 'otsu']) {
        const { data } = await w.recognize(preprocess(bitmap, mode));
        if (!best || data.confidence > best.conf) best = { text: data.text.trim(), conf: data.confidence };
        if (best.conf >= GOOD_CONF) break;
      }
    } catch (e) {
      // воркер мог упасть — пересоздадим на следующей картинке
      try { await worker.terminate(); } catch {}
      worker = null;
      throw e;
    }
    return best;
  }

  /** engine: 'auto' | 'paddle' | 'tesseract' → { text, conf, engine, warn } */
  async function process(bitmap, { engine, lang, status }) {
    onStatus = status || (() => {});
    const res = {}, errors = [];

    if (engine !== 'paddle') {
      try { res.tesseract = await tesseract(bitmap, lang); }
      catch (e) { errors.push('Tesseract: ' + (e.message || e)); }
    }
    const needPaddle = engine === 'paddle' ||
      (engine === 'auto' && (!res.tesseract || res.tesseract.conf < GOOD_CONF));
    if (needPaddle) {
      try { res.paddle = await PaddleOCR.recognize(bitmap, onStatus); }
      catch (e) { errors.push('PaddleOCR: ' + (e.message || e)); }
    }

    const t = res.tesseract, p = res.paddle;
    if (!t && !p) throw new Error(errors.join(' | ') || 'Нет результата');
    let pick = 'tesseract';
    if (p && (!t || (p.text.trim() && p.conf >= t.conf - 10))) pick = 'paddle';
    return { ...res[pick], engine: pick, warn: errors.join(' | ') };
  }

  return { process };
})();
