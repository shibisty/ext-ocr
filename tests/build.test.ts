import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { htmlRefs, manifestRefs, verifyDist } from '../build/extension-plugin.ts';
import { RUNTIME_FILES, vendorFiles } from '../build/vendor.ts';

const root = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('vendorFiles', () => {
  it('находит все движки в node_modules и покрывает RUNTIME_FILES из lib/', () => {
    const { copies } = vendorFiles(root);
    const to = copies.map((c) => c.to);
    for (const f of RUNTIME_FILES.filter((f) => f.startsWith('lib/'))) expect(to).toContain(f);
    for (const c of copies) expect(fs.existsSync(c.from)).toBe(true);
    expect(new Set(to).size).toBe(to.length);
  });

  it('без node_modules — понятная ошибка', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
    expect(() => vendorFiles(tmp)).toThrow(/npm install/);
  });

  it('модели: отсутствующие перечисляются, а не роняют сборку', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');   // junction — без прав админа на Windows
    fs.mkdirSync(path.join(tmp, 'models'));
    fs.writeFileSync(path.join(tmp, 'models/dict.txt'), 'a\n');
    fs.writeFileSync(path.join(tmp, 'models/rec.onnx'), '');   // пустой = нет
    const r = vendorFiles(tmp);
    expect(r.missingModels).toEqual(['det.onnx', 'rec.onnx']);
    expect(r.copies.map((c) => c.to)).toContain('lib/models/dict.txt');
  });
});

describe('проверка сборки', () => {
  it('htmlRefs берёт только локальные ссылки', () => {
    expect(htmlRefs('<script src="./a.js"></script><link href="b.css?x=1"><a href="#x"><img src="data:x"><a href="https://y">'))
      .toEqual(['./a.js', 'b.css']);
  });

  it('manifestRefs', () => {
    expect(manifestRefs(JSON.parse(read('public/manifest.json')))).toEqual(['background.js', 'popup.html', 'sidepanel.html']);
  });

  it('verifyDist находит недостающие файлы', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
    expect(verifyDist(tmp)).toEqual(['нет manifest.json']);
    fs.copyFileSync(path.join(root, 'public/manifest.json'), path.join(tmp, 'manifest.json'));
    fs.writeFileSync(path.join(tmp, 'popup.html'), '<script src="./assets/x.js"></script>');
    const p = verifyDist(tmp);
    expect(p).toContain('manifest.json → background.js');
    expect(p).toContain('manifest.json → sidepanel.html');
    expect(p).toContain('код → engine.html');
    expect(p).toContain('popup.html → ./assets/x.js');
    expect(p).not.toContain('manifest.json → popup.html');
  });
});

describe('исходники страниц', () => {
  it('popup / sidepanel / ocr отличаются только режимом', () => {
    const norm = (f: string) => read(f).replace(/<body data-mode="\w+" class="\w+">/, '<body>');
    expect(norm('sidepanel.html')).toBe(norm('popup.html'));
    expect(norm('ocr.html')).toBe(norm('popup.html'));
    expect(read('popup.html')).toContain('data-mode="popup"');
    expect(read('sidepanel.html')).toContain('data-mode="side"');
    expect(read('ocr.html')).toContain('data-mode="full"');
  });

  it('манифест MV3: модульный service worker, CSP с wasm-unsafe-eval', () => {
    const m = JSON.parse(read('public/manifest.json'));
    expect(m.manifest_version).toBe(3);
    expect(m.background).toEqual({ service_worker: 'background.js', type: 'module' });
    expect(m.content_security_policy.extension_pages).toContain("'wasm-unsafe-eval'");
    expect(m.permissions).toEqual(expect.arrayContaining(['offscreen', 'sidePanel', 'contextMenus', 'power', 'unlimitedStorage']));
    expect(m.version).toBe(JSON.parse(read('package.json')).version);
  });

  it('engine.html: библиотеки — обычными скриптами до модуля', () => {
    const html = read('engine.html');
    const t = html.indexOf('tesseract.min.js'), o = html.indexOf('ort.wasm.min.js'), m = html.indexOf('type="module"');
    expect(t).toBeGreaterThan(0);
    expect(o).toBeGreaterThan(t);
    expect(m).toBeGreaterThan(o);
  });

  it('все id, которые использует интерфейс, есть в разметке', () => {
    const html = read('popup.html');
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const src = read('src/ui/main.ts');
    const used = new Set([...src.matchAll(/\$(?:in|sel|btn)?\('([\w-]+)'\)/g)].map((m) => m[1]));
    for (const t of ['queue', 'history', 'settings']) used.add('tab-' + t);
    for (const id of ['engine', 'lang', 'target', 'keepImages']) used.add(id);
    const missing = [...used].filter((id) => !ids.has(id));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(30);
  });
});
