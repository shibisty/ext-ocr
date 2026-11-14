import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bitmap, installCanvas } from './helpers/canvas.ts';
import { installChrome } from './helpers/chrome.ts';

vi.mock('../src/engine/paddle.ts', () => ({ recognize: vi.fn() }));
const Paddle = await import('../src/engine/paddle.ts');
const E = await import('../src/engine/ocr-engine.ts');
const paddle = vi.mocked(Paddle.recognize);

type Rec = { text: string; confidence: number };
function installTesseract(results: (Rec | Error)[]) {
  const recognize = vi.fn(async () => {
    const r = results.shift();
    if (!r) throw new Error('нет результата в тесте');
    if (r instanceof Error) throw r;
    return { data: r };
  });
  const terminate = vi.fn(async () => ({}));
  const createWorker = vi.fn(async (_lang: string, _oem: number, opts: { logger: (m: unknown) => void }) => {
    opts.logger({ status: 'recognizing text', progress: 0.5 });
    opts.logger({ status: 'loading', progress: 1 });
    return { recognize, terminate };
  });
  (globalThis as Record<string, unknown>).Tesseract = { createWorker };
  return { recognize, terminate, createWorker };
}

beforeEach(() => { installChrome(); installCanvas(); paddle.mockReset(); });
afterEach(() => { delete (globalThis as Record<string, unknown>).Tesseract; delete (globalThis as Record<string, unknown>).document; });

describe('чистые функции', () => {
  it('otsuThreshold делит двугорбую гистограмму', () => {
    const g = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) g[i] = i < 600 ? 30 + (i % 10) : 200 + (i % 10);
    const t = E.otsuThreshold(g);
    expect(t).toBeGreaterThanOrEqual(39);
    expect(t).toBeLessThan(200);
    expect(E.otsuThreshold(new Uint8Array(10).fill(77))).toBe(128);   // одноцветная — порог по умолчанию
  });

  it('preprocessScale', () => {
    expect(E.preprocessScale(100)).toBe(3);
    expect(E.preprocessScale(800)).toBe(2);
    expect(E.preprocessScale(2000)).toBe(1);
    expect(E.preprocessScale(6400)).toBe(0.5);
  });

  it('toGray: яркость и бинаризация', () => {
    const d = new Uint8ClampedArray([255, 0, 0, 9, 0, 0, 255, 9, 250, 250, 250, 9]);
    E.toGray(d, 'gray');
    expect([d[0], d[1], d[2], d[3], d[4], d[8]]).toEqual([76, 76, 76, 9, 29, 250]);
    const b = new Uint8ClampedArray([10, 10, 10, 255, 240, 240, 240, 255]);
    E.toGray(b, 'otsu');
    expect([b[0], b[4]]).toEqual([0, 255]);
  });

  it.each([
    ['paddle', undefined, true], ['tesseract', undefined, false], ['auto', undefined, true],
    ['auto', { text: 'x', conf: 79 }, true], ['auto', { text: 'x', conf: 80 }, false]
  ] as const)('needPaddle(%s, %o) = %s', (eng, t, want) => expect(E.needPaddle(eng, t)).toBe(want));

  it('choose', () => {
    const t = { text: 'T', conf: 70 }, p = { text: 'P', conf: 61 };
    expect(E.choose(t, p, [])).toEqual({ text: 'P', conf: 61, engine: 'paddle', warn: '' });
    expect(E.choose(t, { text: 'P', conf: 59 }, [])).toMatchObject({ engine: 'tesseract' });
    expect(E.choose(t, { text: '  ', conf: 99 }, [])).toMatchObject({ engine: 'tesseract' });
    expect(E.choose(undefined, { text: '', conf: 0 }, ['Tesseract: x'])).toEqual({ text: '', conf: 0, engine: 'paddle', warn: 'Tesseract: x' });
    expect(() => E.choose(undefined, undefined, ['a', 'b'])).toThrow('a | b');
    expect(() => E.choose(undefined, undefined, [])).toThrow('Нет результата');
  });
});

describe('process', () => {
  it('Tesseract уверен — второй проход и Paddle не нужны', async () => {
    const T = installTesseract([{ text: ' hello \n', confidence: 91 }]);
    const status = vi.fn();
    const r = await E.process(bitmap(400, 100), { engine: 'auto', lang: 'eng', status });
    expect(r).toEqual({ text: 'hello', conf: 91, engine: 'tesseract', warn: '' });
    expect(T.recognize).toHaveBeenCalledTimes(1);
    expect(paddle).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith('Tesseract 50%');
    const opts = T.createWorker.mock.calls[0]![2] as unknown as Record<string, unknown>;
    expect(opts).toMatchObject({ workerPath: 'chrome-extension://test/lib/worker.min.js', corePath: 'chrome-extension://test/lib/core',
      langPath: 'chrome-extension://test/lib/lang', workerBlobURL: false, cacheMethod: 'none' });
  });

  it('auto: два прохода Tesseract, затем Paddle; выбирается лучший', async () => {
    installTesseract([{ text: 'a', confidence: 40 }, { text: 'b', confidence: 60 }, { text: 'c', confidence: 95 }]);
    paddle.mockResolvedValueOnce({ text: 'paddle', conf: 55 });
    const r = await E.process(bitmap(400, 100), { engine: 'auto', lang: 'rus+eng' });
    expect(r).toEqual({ text: 'paddle', conf: 55, engine: 'paddle', warn: '' });
  });

  it('воркер переиспользуется для того же языка и пересоздаётся для другого', async () => {
    const T = installTesseract([{ text: 'a', confidence: 90 }, { text: 'b', confidence: 90 }, { text: 'c', confidence: 90 }]);
    await E.process(bitmap(10, 10), { engine: 'tesseract', lang: 'ukr' });
    await E.process(bitmap(10, 10), { engine: 'tesseract', lang: 'ukr' });
    expect(T.createWorker).toHaveBeenCalledTimes(1);
    await E.process(bitmap(10, 10), { engine: 'tesseract', lang: 'eng' });
    expect(T.createWorker).toHaveBeenCalledTimes(2);
    expect(T.terminate).toHaveBeenCalledTimes(1);
  });

  it('падение Tesseract: предупреждение, воркер сбрасывается, результат от Paddle', async () => {
    const T = installTesseract([new Error('OOM'), { text: 'ok', confidence: 90 }]);
    paddle.mockResolvedValueOnce({ text: 'P', conf: 10 });
    const r = await E.process(bitmap(50, 50), { engine: 'auto', lang: 'zzz' });
    expect(r).toEqual({ text: 'P', conf: 10, engine: 'paddle', warn: 'Tesseract: OOM' });
    expect(T.terminate).toHaveBeenCalled();
    await E.process(bitmap(50, 50), { engine: 'tesseract', lang: 'zzz' });
    expect(T.createWorker).toHaveBeenCalledTimes(2);
  });

  it('только Paddle; ошибка обоих движков — исключение с обеими причинами', async () => {
    paddle.mockResolvedValueOnce({ text: 'p', conf: 1 });
    expect(await E.process(bitmap(5, 5), { engine: 'paddle', lang: 'eng' })).toMatchObject({ engine: 'paddle' });

    installTesseract([new Error('t1')]);
    paddle.mockRejectedValueOnce(new Error('p1'));
    await expect(E.process(bitmap(5, 5), { engine: 'auto', lang: 'x1' })).rejects.toThrow('Tesseract: t1 | PaddleOCR: p1');
  });

  it('предобработка: размер холста и белый фон', async () => {
    const { made } = installCanvas();
    installTesseract([{ text: 'a', confidence: 10 }, { text: 'b', confidence: 20 }]);
    await E.process(bitmap(400, 100), { engine: 'tesseract', lang: 'y' });
    expect(made).toHaveLength(2);
    expect([made[0]!.width, made[0]!.height]).toEqual([1200, 300]);
    expect(made[0]!.ctx.fillStyle).toBe('#fff');
    expect(made[0]!.ctx.putImageData).toHaveBeenCalled();
  });
});
