# Image OCR (offline) — расширение Chrome

Распознавание текста с картинок офлайн (Tesseract + PaddleOCR), очередь, история заданий, экспорт в .xlsx, перевод встроенным Translator API Chrome.

## Команды

```sh
npm install          # зависимости (движки берутся из node_modules при сборке)
npm run setup        # один раз: скачать модели PaddleOCR в models/ (~96 МБ)
npm run build        # tsc + vite build → dist/
npm run dev          # пересборка при изменениях
npm test             # vitest
npm run test:e2e     # живая проверка dist/ в Chrome for Testing (CHROME_PATH=…)
npm run check        # типы + тесты + сборка
```

В `chrome://extensions` → «Режим разработчика» → «Загрузить распакованное» выбирается папка **`dist/`**.
Без моделей PaddleOCR сборка выдаёт предупреждение, распознаёт только Tesseract.

## Устройство

| Путь | Что это |
|---|---|
| `popup.html`, `sidepanel.html`, `ocr.html` | один интерфейс в трёх режимах (`data-mode`), вход Vite → `src/ui/main.ts` |
| `engine.html` | offscreen-документ: обычными `<script>` грузит `lib/tesseract.min.js` и `lib/ort/ort.wasm.min.js`, затем `src/engine/main.ts` |
| `src/background.ts` | service worker (модульный): контекстное меню, запуск движка, keep-awake |
| `src/shared/` | `db.ts` (IndexedDB), `translate.ts`, `xlsx.ts`, `types.ts` (записи, настройки, сообщения шины) |
| `src/engine/` | `host.ts` (цикл очереди, зависимости внедряются), `ocr-engine.ts` (Tesseract + выбор результата), `paddle.ts` + `paddle-core.ts` (чистая часть без DOM) |
| `src/ui/` | `main.ts` (DOM), `format.ts` (чистая логика: карточки, история, фильтры, строки экспорта), `ui.css` |
| `build/` | плагин Vite: копирует движки из `node_modules` и `models/` в `dist/lib`, проверяет, что манифест и страницы ссылаются на существующие файлы |
| `public/manifest.json` | манифест MV3 |
| `legacy/` | исходный JS до перехода на TypeScript — нужен тестам паритета (`tests/parity.test.ts`, `tests/ui.test.ts`) |

Интерфейсы и движок общаются через `BroadcastChannel('ocr')`, типы сообщений — `BusMessage` в `src/shared/types.ts`.

## Тесты

- `db`, `translate`, `xlsx`, `paddle-core`, `ocr-engine`, `host`, `background`, `format`, `build` — модульные (fake-indexeddb, подделки `chrome.*`, canvas, Translator API).
- `ui.test.ts` (happy-dom) — старый `legacy/ui.js` и новый интерфейс на одних данных дают одинаковую разметку и сообщения; плюс сценарии кликов.
- `parity.test.ts` — xlsx байт в байт, нарезка текста, состояние базы, рамки/строки PaddleOCR и предобработка Tesseract совпадают со старым кодом.
- `e2e/run.ts` — Chrome for Testing с `--load-extension=dist`: распознавание `e2e/fixtures/hello.png` (Tesseract и PaddleOCR), offscreen, экспорт, история, попап. Обычный Chrome 137+ не загружает распакованные расширения из командной строки.
