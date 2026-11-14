// Плагин Vite: копирует движки в dist/lib и проверяет, что манифест и страницы ссылаются только на существующие файлы.
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';
import { RUNTIME_FILES, vendorFiles } from './vendor.ts';

interface Manifest {
  background?: { service_worker?: string };
  action?: { default_popup?: string };
  side_panel?: { default_path?: string };
  [k: string]: unknown;
}

/** Пути, на которые ссылается манифест. */
export function manifestRefs(m: Manifest): string[] {
  return [m.background?.service_worker, m.action?.default_popup, m.side_panel?.default_path]
    .filter((x): x is string => !!x);
}

/** Локальные src/href в HTML (без http:, data:, #…). Пути относительно самого HTML-файла. */
export function htmlRefs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) {
    const u = m[1]!;
    if (/^(?:[a-z]+:|#|\/\/)/i.test(u)) continue;
    out.push(u.split(/[?#]/)[0]!);
  }
  return out;
}

/** Проверить готовую папку расширения; возвращает список проблем. */
export function verifyDist(dir: string): string[] {
  const problems: string[] = [];
  const exists = (rel: string) => fs.existsSync(path.join(dir, rel));
  if (!exists('manifest.json')) return ['нет manifest.json'];
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Manifest;
  for (const r of manifestRefs(m)) if (!exists(r)) problems.push(`manifest.json → ${r}`);
  for (const r of RUNTIME_FILES) if (!exists(r)) problems.push(`код → ${r}`);
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    for (const r of htmlRefs(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      const rel = path.posix.normalize(r.replace(/^\.?\//, ''));
      if (!exists(rel)) problems.push(`${f} → ${r}`);
    }
  }
  return problems;
}

export function extensionPlugin(root: string): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'ocr-extension',
    configResolved(c) { config = c; },
    writeBundle() {
      const out = path.resolve(config.root, config.build.outDir);
      const { copies, missingModels } = vendorFiles(root);
      for (const c of copies) {
        const dest = path.join(out, c.to);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(c.from, dest);
      }
      if (missingModels.length) {
        config.logger.warn(`\n! Нет моделей PaddleOCR в models/: ${missingModels.join(', ')}. ` +
          'Запустите npm run setup — без них работает только Tesseract.');
      }
      const problems = verifyDist(out);
      if (problems.length) throw new Error('Сборка неполная:\n  ' + problems.join('\n  '));
      config.logger.info(`ocr-extension: скопировано файлов движков: ${copies.length}`);
    }
  };
}
