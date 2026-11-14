// Библиотеки, которые engine.html подключает обычными <script> из lib/ (см. build/vendor.ts).
// Tesseract — UMD-глобал из типов tesseract.js (включён allowUmdGlobalAccess).
declare const ort: typeof import('onnxruntime-web');
