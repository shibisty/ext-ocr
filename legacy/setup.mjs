// Копирует движки из node_modules в lib/ и скачивает ONNX-модели PaddleOCR.
// Нужен Node 18+ (встроенный fetch).
import fs from 'fs';
import path from 'path';

const nm = 'node_modules';
const LANGS = ['eng', 'rus', 'ukr'];
const mk = (d) => fs.mkdirSync(d, { recursive: true });
const cp = (from, to) => { fs.copyFileSync(from, to); console.log('+', to); };

mk('lib/core'); mk('lib/lang'); mk('lib/ort'); mk('lib/models');

// ---------- Tesseract ----------
cp(path.join(nm, 'tesseract.js/dist/tesseract.min.js'), 'lib/tesseract.min.js');
cp(path.join(nm, 'tesseract.js/dist/worker.min.js'), 'lib/worker.min.js');

const coreDir = path.join(nm, 'tesseract.js-core');
for (const f of fs.readdirSync(coreDir)) {
  if (/^tesseract-core.*lstm.*\.(js|wasm)$/.test(f)) cp(path.join(coreDir, f), path.join('lib/core', f));
}

for (const l of LANGS) {
  const base = path.join(nm, '@tesseract.js-data', l);
  const dir = ['4.0.0_best_int', '4.0.0', '4.0.0_fast']
    .map((d) => path.join(base, d))
    .find((d) => fs.existsSync(path.join(d, `${l}.traineddata.gz`)));
  if (!dir) { console.warn('! нет данных для', l); continue; }
  cp(path.join(dir, `${l}.traineddata.gz`), path.join('lib/lang', `${l}.traineddata.gz`));
}

// ---------- onnxruntime-web ----------
const ortDist = path.join(nm, 'onnxruntime-web/dist');
cp(path.join(ortDist, 'ort.wasm.min.js'), 'lib/ort/ort.wasm.min.js');
const ortFiles = fs.readdirSync(ortDist).filter((f) => /^ort-wasm-simd-threaded\.(mjs|wasm)$/.test(f));
if (ortFiles.length < 2) console.warn('! не нашёл ort-wasm-simd-threaded.{mjs,wasm} в', ortDist);
for (const f of ortFiles) cp(path.join(ortDist, f), path.join('lib/ort', f));

// ---------- модели PaddleOCR (кириллица) ----------
const HF = 'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/';
const MODELS = [
  { out: 'det.onnx', tries: ['detection/v5/det.onnx', 'detection/PP-OCRv5_server_det.onnx'] },
  { out: 'rec.onnx', tries: ['languages/eslav/rec.onnx', 'eslav/eslav_PP-OCRv5_mobile_rec.onnx'] },
  { out: 'dict.txt', tries: ['languages/eslav/dict.txt', 'eslav/ppocrv5_eslav_dict.txt'] }
];

for (const m of MODELS) {
  const dest = path.join('lib/models', m.out);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { console.log('=', dest, '(уже есть)'); continue; }
  let ok = false;
  for (const rel of m.tries) {
    process.stdout.write(`↓ ${rel} … `);
    try {
      const res = await fetch(HF + rel);
      if (!res.ok) { console.log(res.status); continue; }
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      console.log('ok →', dest);
      ok = true; break;
    } catch (e) { console.log('ошибка', e.message); }
  }
  if (!ok) console.warn(`! не удалось скачать ${m.out}. Положите файл вручную в lib/models/`);
}

console.log('\nГотово. Загрузите папку в chrome://extensions (Режим разработчика → Загрузить распакованное).');
