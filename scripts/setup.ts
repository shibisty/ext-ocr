// Скачивает ONNX-модели PaddleOCR в models/ (движки Tesseract/onnxruntime копирует сама сборка из node_modules).
// Запуск: npm run setup (Node 22.18+ — TypeScript запускается напрямую).
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'models';
const HF = 'https://huggingface.co/monkt/paddleocr-onnx/resolve/main/';
const MODELS = [
  { out: 'det.onnx', tries: ['detection/v5/det.onnx', 'detection/PP-OCRv5_server_det.onnx'] },
  { out: 'rec.onnx', tries: ['languages/eslav/rec.onnx', 'eslav/eslav_PP-OCRv5_mobile_rec.onnx'] },
  { out: 'dict.txt', tries: ['languages/eslav/dict.txt', 'eslav/ppocrv5_eslav_dict.txt'] }
];

fs.mkdirSync(OUT, { recursive: true });
let failed = 0;
for (const m of MODELS) {
  const dest = path.join(OUT, m.out);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { console.log('=', dest, '(уже есть)'); continue; }
  let ok = false;
  for (const rel of m.tries) {
    process.stdout.write(`↓ ${rel} … `);
    try {
      const res = await fetch(HF + rel);
      if (!res.ok) { console.log(res.status); continue; }
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      console.log('ok →', dest);
      ok = true;
      break;
    } catch (e) { console.log('ошибка', (e as Error).message); }
  }
  if (!ok) { failed++; console.warn(`! не удалось скачать ${m.out}. Положите файл вручную в ${OUT}/`); }
}

console.log(failed ? '\nНе все модели скачаны.' : '\nГотово. Теперь npm run build и загрузите папку dist/ в chrome://extensions.');
process.exitCode = failed ? 1 : 0;
