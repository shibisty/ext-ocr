const $ = (id) => document.getElementById(id);
const GOOD_CONF = 80;   // выше этого порога дальше не пробуем
const LOW_CONF = 70;    // ниже — предупреждаем

let worker = null;
let workerLang = null;
let busy = false;

const setStatus = (t) => ($('status').textContent = t);

async function getWorker(lang) {
  if (worker && workerLang === lang) return worker;
  if (worker) await worker.terminate();
  setStatus('Загрузка движка…');
  worker = await Tesseract.createWorker(lang, 1, {
    workerPath: chrome.runtime.getURL('lib/worker.min.js'),
    corePath: chrome.runtime.getURL('lib/core'),
    langPath: chrome.runtime.getURL('lib/lang'),
    workerBlobURL: false,   // blob-воркеры запрещены CSP расширений
    cacheMethod: 'none',    // данные и так лежат локально
    logger: (m) => {
      if (m.status === 'recognizing text') setStatus(`Распознаю… ${Math.round(m.progress * 100)}%`);
    }
  });
  workerLang = lang;
  return worker;
}

// ---------- предобработка ----------
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
  // мелкий текст лучше распознаётся после увеличения
  const scale = Math.max(1, Math.min(3, 1600 / bitmap.width));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
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

// ---------- основной сценарий ----------
async function runOcr(blob) {
  if (busy) return;
  busy = true;
  try {
    $('preview').src = URL.createObjectURL(blob);
    $('preview').hidden = false;
    $('out').value = '';
    $('conf').textContent = '';

    const bitmap = await createImageBitmap(blob);
    const w = await getWorker($('lang').value);

    let best = null;
    for (const mode of ['gray', 'otsu']) {
      setStatus(`Распознаю (${mode})…`);
      const { data } = await w.recognize(preprocess(bitmap, mode));
      if (!best || data.confidence > best.conf) best = { text: data.text, conf: data.confidence, mode };
      if (best.conf >= GOOD_CONF) break;
    }

    $('out').value = best.text.trim();
    $('conf').textContent = `Уверенность: ${best.conf.toFixed(0)}% (${best.mode})` +
      (best.conf < LOW_CONF ? ' — низкая, результат может быть неточным' : '');
    setStatus('Готово');
  } catch (e) {
    console.error(e);
    setStatus('Ошибка: ' + (e.message || e));
  } finally {
    busy = false;
  }
}

async function runFromUrl(src) {
  try {
    setStatus('Загрузка картинки…');
    const res = await fetch(src);
    await runOcr(await res.blob());
  } catch (e) {
    setStatus('Не удалось загрузить картинку: ' + e.message);
  }
}

// ---------- ввод ----------
document.addEventListener('paste', (e) => {
  const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
  if (item) runOcr(item.getAsFile());
});

const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => {
  const f = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (f) runOcr(f);
});
$('file').addEventListener('change', (e) => e.target.files[0] && runOcr(e.target.files[0]));
$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('out').value);
  setStatus('Скопировано');
});

// картинка, переданная из контекстного меню
(async () => {
  const { pendingSrc } = await chrome.storage.session.get('pendingSrc');
  if (pendingSrc) {
    await chrome.storage.session.remove('pendingSrc');
    runFromUrl(pendingSrc);
  }
})();
