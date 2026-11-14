// Какие файлы движков нужно положить в dist/lib. Раньше это делал setup.mjs в папку lib/ — теперь сборка.
import fs from 'node:fs';
import path from 'node:path';

export interface Copy { from: string; to: string }

export const LANGS = ['eng', 'rus', 'ukr'] as const;
/** Варианты traineddata в порядке предпочтения. */
export const LANG_VARIANTS = ['4.0.0_best_int', '4.0.0', '4.0.0_fast'] as const;
export const MODEL_FILES = ['det.onnx', 'rec.onnx', 'dict.txt'] as const;

export const CORE_RE = /^tesseract-core.*lstm.*\.(js|wasm)$/;
export const ORT_RE = /^ort-wasm-simd-threaded\.(mjs|wasm)$/;

/** Список копирований из node_modules (+ models/) в выходную папку. Бросает, если чего-то не хватает. */
export function vendorFiles(root: string): { copies: Copy[]; missingModels: string[] } {
  const nm = path.join(root, 'node_modules');
  const copies: Copy[] = [];
  const need = (from: string, to: string) => {
    if (!fs.existsSync(from)) throw new Error(`Нет файла ${path.relative(root, from)} — выполните npm install`);
    copies.push({ from, to });
  };

  // ---------- Tesseract ----------
  need(path.join(nm, 'tesseract.js/dist/tesseract.min.js'), 'lib/tesseract.min.js');
  need(path.join(nm, 'tesseract.js/dist/worker.min.js'), 'lib/worker.min.js');
  const coreDir = path.join(nm, 'tesseract.js-core');
  const core = fs.existsSync(coreDir) ? fs.readdirSync(coreDir).filter((f) => CORE_RE.test(f)).sort() : [];
  if (!core.length) throw new Error('Нет tesseract.js-core — выполните npm install');
  for (const f of core) copies.push({ from: path.join(coreDir, f), to: `lib/core/${f}` });

  for (const l of LANGS) {
    const base = path.join(nm, '@tesseract.js-data', l);
    const dir = LANG_VARIANTS.map((d) => path.join(base, d)).find((d) => fs.existsSync(path.join(d, `${l}.traineddata.gz`)));
    if (!dir) throw new Error(`Нет языковых данных ${l} (@tesseract.js-data/${l}) — выполните npm install`);
    copies.push({ from: path.join(dir, `${l}.traineddata.gz`), to: `lib/lang/${l}.traineddata.gz` });
  }

  // ---------- onnxruntime-web ----------
  const ortDist = path.join(nm, 'onnxruntime-web/dist');
  need(path.join(ortDist, 'ort.wasm.min.js'), 'lib/ort/ort.wasm.min.js');
  const ort = fs.existsSync(ortDist) ? fs.readdirSync(ortDist).filter((f) => ORT_RE.test(f)).sort() : [];
  if (ort.length < 2) throw new Error('Не нашёл ort-wasm-simd-threaded.{mjs,wasm} в onnxruntime-web/dist');
  for (const f of ort) copies.push({ from: path.join(ortDist, f), to: `lib/ort/${f}` });

  // ---------- модели PaddleOCR (скачивает npm run setup) ----------
  const missingModels: string[] = [];
  for (const f of MODEL_FILES) {
    const from = path.join(root, 'models', f);
    if (fs.existsSync(from) && fs.statSync(from).size > 0) copies.push({ from, to: `lib/models/${f}` });
    else missingModels.push(f);
  }
  return { copies, missingModels };
}

/** Файлы, к которым код обращается через chrome.runtime.getURL — должны быть в сборке. */
export const RUNTIME_FILES = [
  'engine.html', 'ocr.html',
  'lib/tesseract.min.js', 'lib/worker.min.js',
  'lib/core/tesseract-core-lstm.wasm.js', 'lib/core/tesseract-core-simd-lstm.wasm.js',
  ...LANGS.map((l) => `lib/lang/${l}.traineddata.gz`),
  'lib/ort/ort.wasm.min.js', 'lib/ort/ort-wasm-simd-threaded.mjs', 'lib/ort/ort-wasm-simd-threaded.wasm'
];
