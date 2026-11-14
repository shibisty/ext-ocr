// Паритет с исходным JS (папка legacy/): новый TypeScript должен вести себя так же.
// Старые файлы — IIFE со своими глобалами; достаём внутренние функции подстановкой в текст.
import fs from 'node:fs';
import path from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import * as DB from '../src/shared/db.ts';
import * as Tr from '../src/shared/translate.ts';
import * as X from '../src/shared/xlsx.ts';
import * as P from '../src/engine/paddle-core.ts';
import * as E from '../src/engine/ocr-engine.ts';
import { bitmap, installCanvas } from './helpers/canvas.ts';
import { entry } from './helpers/data.ts';

const legacyDir = path.resolve(import.meta.dirname, '../legacy');
const has = fs.existsSync(path.join(legacyDir, 'db.js'));
const src = (f: string) => fs.readFileSync(path.join(legacyDir, f), 'utf8');
const load = <T>(file: string, expose: string, patch?: [string, string], args: Record<string, unknown> = {}): T => {
  let s = src(file);
  if (patch) { expect(s).toContain(patch[0]); s = s.replace(patch[0], patch[1]); }
  return new Function(...Object.keys(args), 'module', `${s}\nreturn ${expose};`)(...Object.values(args), undefined) as T;
};

/** Детерминированный генератор. */
function rng(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
}

describe.skipIf(!has)('паритет с legacy/', () => {
  it('xlsx: байт в байт (до 26 колонок)', async () => {
    const L = load<{ build: typeof X.build }>('xlsx.js', 'XLSX');
    const r = rng(1);
    for (let n = 0; n < 30; n++) {
      const cols = 1 + Math.floor(r() * 26), rowsN = Math.floor(r() * 20);
      const rows: X.Cell[][] = [Array.from({ length: cols }, (_, i) => 'h' + i)];
      for (let i = 0; i < rowsN; i++) {
        rows.push(Array.from({ length: cols }, () => {
          const k = r();
          return k < 0.2 ? null : k < 0.4 ? Math.round(r() * 1e4) / 10 : k < 0.5 ? '' : k < 0.55 ? NaN
            : 'текст <&> "q"\n\u0001' + 'x'.repeat(Math.floor(r() * 50));
        }));
      }
      const opts = { sheetName: n % 3 ? 'OCR' : 'a/b*' + 'z'.repeat(40), widths: n % 2 ? [6, 36, 20] : [] };
      const a = new Uint8Array(await L.build(rows, opts).arrayBuffer());
      const b = new Uint8Array(await X.build(rows, opts).arrayBuffer());
      expect(b).toEqual(a);
    }
  });

  it('xlsx: после 26 колонок старый colName был неверен (исправлено)', () => {
    const L = load<(i: number) => string>('xlsx.js', 'XLSX.colName', ['return { build };', 'return { build, colName };'], {});
    expect(L(25)).toBe(X.colName(25));
    expect(L(27)).toBe('BA');              // было: буквы задом наперёд
    expect(X.colName(27)).toBe('AB');
  });

  it('translate: chunk', () => {
    const L = load<{ _chunk: typeof Tr.chunk }>('translate.js', 'Tr');
    const r = rng(2);
    for (let n = 0; n < 200; n++) {
      let s = '';
      const len = Math.floor(r() * 5000);
      while (s.length < len) { const k = r(); s += k < 0.1 ? '\n' : k < 0.3 ? ' ' : k < 0.32 ? '\n\n' : String.fromCharCode(0x430 + Math.floor(r() * 32)); }
      const max = [50, 300, 1200][n % 3]!;
      expect(Tr.chunk(s, max)).toEqual(L._chunk(s, max));
    }
  });

  it('translate: needs / needsAuto', () => {
    const L = load<{ needs: typeof Tr.needs; needsAuto: typeof Tr.needsAuto }>('translate.js', 'Tr');
    const states = ['', 'ok', 'same', 'unknown', 'unsupported', 'need-download', 'error', undefined] as const;
    for (const status of ['done', 'error', 'pending'] as const)
      for (const text of ['', ' ', 'x', undefined])
        for (const tState of states)
          for (const tTarget of ['', 'ru', 'en', undefined]) {
            const i = { key: 'k', seq: 1, jobId: 1, name: '', path: '', size: 0, prio: 0, hasBlob: true, status, text, tState, tTarget };
            expect(Tr.needs(i, 'ru')).toBe(!!L.needs(i, 'ru'));
            expect(Tr.needsAuto(i, 'ru')).toBe(!!L.needsAuto(i, 'ru'));
          }
  });

  it('db: одинаковое состояние после одной и той же последовательности операций', async () => {
    type Api = typeof DB;
    const script = async (D: Api) => {
      const a = await D.enqueue([entry('s/1.png'), entry('s/2.png'), entry('s/3.png')], { jobName: 'A' });
      await new Promise((r) => setTimeout(r, 3));
      await D.enqueue([entry('4.png')], { jobName: 'B' });
      const all = (await D.getAllItems()).sort((x, y) => x.seq - y.seq);
      await D.patchItem(all[0]!.key, (r) => Object.assign(r, { status: 'done', text: 'T', conf: 50, engine: 'paddle', junk: 1 }));
      await D.patchItem(all[1]!.key, (r) => Object.assign(r, { status: 'error', error: 'E' }));
      await D.patchItem(all[2]!.key, (r) => { r.status = 'processing'; });
      await new Promise((r) => setTimeout(r, 3));   // в старой версии задания в одну миллисекунду затирали друг друга
      const re = await D.enqueue([entry('s/2.png'), entry('s/1.png'), entry('5.png')]);
      const reset = await D.resetProcessing();
      await D.patchItem(all[0]!.key, (r) => { r.status = 'done'; });
      await D.dropBlobs();
      const rs = await D.resetItems((r) => r.status !== 'pending', 1);
      await D.finishJobs();
      await D.patchJob(a.jobId, (j) => { j.startedAt = 1; });
      await D.reserveSeq(4);
      await D.setMeta('settings', { engine: 'tesseract' });
      const counts = [await D.countPending(), (await D.pendingItems()).length, reset, re.added, re.skipped, re.requeued, rs.reset, rs.noBlob];
      const jobs = (await D.getJobs()).sort((x, y) => x.createdAt - y.createdAt);
      const ids = new Map(jobs.map((j, i) => [j.id, i]));
      const items = (await D.getAllItems()).sort((x, y) => x.seq - y.seq)
        .map((i) => ({ ...i, jobId: ids.get(i.jobId!) ?? i.jobId }));
      const blobs = await Promise.all(items.map(async (i) => { const b = await D.getBlob(i.key); return b ? await b.text() : null; }));
      return {
        counts, items, blobs, settings: await D.getSettings(), seq: await D.getMeta('seq'),
        jobs: jobs.map((j) => ({ ...j, id: ids.get(j.id), createdAt: ids.get(j.createdAt), finishedAt: !!j.finishedAt }))
      };
    };

    const L = load<Api>('db.js', 'DB', undefined, { self: globalThis });
    const legacy = await script(L);
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    const fresh = await script(DB);
    expect(fresh).toEqual(legacy);
    expect(legacy.items.length).toBe(5);
  });

  it('paddle: рамки, строки и CTC совпадают', () => {
    const L = load<{ findBoxes: typeof P.findBoxes; groupLines: typeof P.groupLines }>('paddle.js', 'window.PaddleOCR',
      ['window.PaddleOCR = { recognize };', 'window.PaddleOCR = { recognize, findBoxes, groupLines };'],
      { chrome: { runtime: { getURL: (p: string) => p } }, window: {} });
    const r = rng(3);
    for (let n = 0; n < 20; n++) {
      const w = 64 + Math.floor(r() * 100), h = 32 + Math.floor(r() * 60);
      const prob = new Float32Array(w * h);
      for (let k = 0; k < 15; k++) {
        const x0 = Math.floor(r() * w), y0 = Math.floor(r() * h), bw = 2 + Math.floor(r() * 30), bh = 2 + Math.floor(r() * 10), v = 0.2 + r() * 0.8;
        for (let y = y0; y < Math.min(h, y0 + bh); y++) for (let x = x0; x < Math.min(w, x0 + bw); x++) prob[y * w + x] = v;
      }
      const a = L.findBoxes(prob, w, h), b = P.findBoxes(prob, w, h);
      expect(b).toEqual(a);
      expect(P.groupLines(structuredClone(b))).toEqual(L.groupLines(structuredClone(a)));
    }
  });

  it('paddle: полный recognize с подделанным ort — тот же текст и уверенность', async () => {
    // одна и та же «модель» для обеих версий: карта вероятностей из картинки, CTC — из позиции рамки
    const W = 200, H = 90;
    const pixel = (i: number): [number, number, number] => {
      const x = i % W, y = Math.floor(i / W);
      return (y > 10 && y < 30 && x > 20 && x < 90) || (y > 12 && y < 28 && x > 110 && x < 180) || (y > 55 && y < 75 && x > 30 && x < 160)
        ? [0, 0, 0] : [255, 255, 255];
    };
    const makeOrt = () => {
      class Tensor { constructor(readonly type: string, readonly data: Float32Array, readonly dims: number[]) {} }
      const session = (kind: 'det' | 'rec') => ({
        inputNames: ['x'], outputNames: ['y'],
        run: async (feeds: Record<string, Tensor>) => {
          const t = feeds.x!;
          const [, , h, w] = t.dims as [number, number, number, number];
          if (kind === 'det') {
            const plane = w * h, out = new Float32Array(plane);
            for (let i = 0; i < plane; i++) out[i] = t.data[i]! < 0 ? 0.95 : 0;   // тёмное → текст
            return { y: new Tensor('float32', out, [1, 1, h, w]) };
          }
          const T = Math.max(2, Math.round(w / 8)), C = 5, out = new Float32Array(T * C);
          for (let s = 0; s < T; s++) out[s * C + ((s + w) % C)] = 0.5 + ((s * 7) % 5) / 10;
          return { y: new Tensor('float32', out, [1, T, C]) };
        }
      });
      let n = 0;
      return { env: { wasm: {} }, Tensor, InferenceSession: { create: async () => session(n++ === 0 ? 'det' : 'rec') } };
    };
    const fetchStub = async (u: string) => new Response(u.endsWith('dict.txt') ? 'a\nb\nc\n' : new Uint8Array([1]));
    const chromeStub = { runtime: { getURL: (p: string) => 'x/' + p } };

    // старая версия
    const canv1 = installCanvas(pixel);
    void canv1;
    const win: Record<string, unknown> = {};
    const g = globalThis as Record<string, unknown>;
    g.fetch = fetchStub; g.chrome = chromeStub; g.ort = makeOrt();
    new Function('chrome', 'window', 'ort', src('paddle.js'))(chromeStub, win, g.ort);
    const legacy = await (win.PaddleOCR as { recognize: (b: ImageBitmap) => Promise<unknown> }).recognize(bitmap(W, H));

    // новая
    installCanvas(pixel);
    g.ort = makeOrt();
    const { recognize } = await import('../src/engine/paddle.ts');
    const fresh = await recognize(bitmap(W, H));
    expect(fresh).toEqual(legacy);
    expect((legacy as { text: string }).text.split('\n')).toHaveLength(2);
    delete g.ort; delete g.chrome; delete g.document;
  });

  it('engine: порог Оцу и предобработка дают те же пиксели', () => {
    const r = rng(4);
    for (const [w, h] of [[300, 40], [1700, 20], [3500, 10]] as const) {
      const shade = Array.from({ length: 64 }, () => [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)] as [number, number, number]);
      const pixel = (i: number) => shade[(i * 2654435761 >>> 0) % 64]!;
      for (const mode of ['gray', 'otsu'] as const) {
        const { made } = installCanvas(pixel);
        const L = load<{ preprocess: (b: ImageBitmap, m: string) => unknown }>('engine.js', 'Engine',
          ['return { process };', 'return { process, preprocess };'], { chrome: {}, Tesseract: {}, PaddleOCR: {} });
        L.preprocess(bitmap(w, h), mode);
        const lc = made[0]!;
        const legacyOut = (lc.ctx.putImageData.mock.calls[0]![0] as { data: Uint8ClampedArray }).data;

        const scale = E.preprocessScale(w);
        expect([lc.width, lc.height]).toEqual([Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))]);
        const mine = lc.ctx.getImageData(0, 0, lc.width, lc.height).data;
        E.toGray(mine, mode);
        expect(mine).toEqual(legacyOut);
      }
    }
  });
});
