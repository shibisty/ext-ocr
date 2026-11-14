import { describe, expect, it } from 'vitest';
import * as P from '../src/engine/paddle-core.ts';

/** Карта вероятностей w×h с прямоугольниками заданной вероятности. */
function probMap(w: number, h: number, rects: [number, number, number, number, number][]) {
  const m = new Float32Array(w * h);
  for (const [x0, y0, x1, y1, v] of rects) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * w + x] = v;
  return m;
}

describe('detSize', () => {
  it('кратно 32, ограничение по стороне и увеличению', () => {
    expect(P.detSize(2560, 1280)).toMatchObject({ rw: 1280, rh: 640 });
    expect(P.detSize(100, 50)).toMatchObject({ rw: 288, rh: 160 });           // ×3, округление до 32
    expect(P.detSize(10, 10)).toMatchObject({ rw: 32, rh: 32 });              // минимум 32
    const s = P.detSize(1000, 333);
    expect(s.rw % 32).toBe(0); expect(s.rh % 32).toBe(0);
    expect(s.sx).toBeCloseTo(1000 / s.rw); expect(s.sy).toBeCloseTo(333 / s.rh);
  });
});

describe('detInput / recInput', () => {
  it('BGR-плоскости и нормализация', () => {
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);   // красный, зелёный
    const d = P.detInput(px, 2, 1);
    expect(d).toHaveLength(6);
    expect(d[0]).toBeCloseTo((0 - 0.406) / 0.225);    // B красного
    expect(d[4]).toBeCloseTo((1 - 0.485) / 0.229);    // R красного
    expect(d[3]).toBeCloseTo((1 - 0.456) / 0.224);    // G зелёного
    const r = P.recInput(px, 2, 1);
    expect([...r]).toEqual([-1, -1, -1, 1, 1, -1]);
  });
});

describe('findBoxes', () => {
  it('находит отдельные области и расширяет их (unclip)', () => {
    const w = 60, h = 20;
    const boxes = P.findBoxes(probMap(w, h, [[2, 2, 21, 6, 0.9], [30, 10, 49, 14, 0.8]]), w, h);
    expect(boxes).toHaveLength(2);
    const [a] = boxes;
    const d = (20 * 5 * 1.5) / (2 * 25);
    expect(a).toMatchObject({ x0: 2 - d, y0: 2 - d, x1: 22 + d, y1: 7 + d });
    expect(a!.score).toBeCloseTo(0.9);
  });

  it('отбрасывает мелкие, тонкие и неуверенные области', () => {
    const w = 40, h = 20;
    const prob = probMap(w, h, [
      [0, 0, 2, 2, 0.9],          // 9 пикселей < 10
      [5, 5, 30, 6, 0.9],         // высота 2 < 3
      [5, 10, 30, 15, 0.5]        // средняя 0.5 < boxThresh
    ]);
    expect(P.findBoxes(prob, w, h)).toEqual([]);
  });

  it('диагональная связность объединяет области', () => {
    const w = 20, h = 20;
    const prob = probMap(w, h, [[0, 0, 4, 4, 0.9], [5, 5, 9, 9, 0.9]]);
    expect(P.findBoxes(prob, w, h)).toHaveLength(1);
  });

  it('ниже порога бинаризации — пусто', () => {
    expect(P.findBoxes(probMap(10, 10, [[0, 0, 9, 9, 0.3]]), 10, 10)).toEqual([]);
  });
});

describe('scaleBoxes', () => {
  it('масштаб, обрезка по краям и отброс вырожденных', () => {
    const out = P.scaleBoxes([{ x0: -2, y0: 1, x1: 10, y1: 5 }, { x0: 3, y0: 3, x1: 3.5, y1: 9 }], 2, 2, 15, 100);
    expect(out).toEqual([{ x0: 0, y0: 2, x1: 15, y1: 10 }]);
  });
});

describe('groupLines', () => {
  it('строки сверху вниз, слова слева направо', () => {
    const b = (x0: number, y0: number, w = 10, h = 10) => ({ x0, y0, x1: x0 + w, y1: y0 + h });
    const lines = P.groupLines([b(50, 31), b(0, 0), b(30, 2), b(0, 30), b(60, 1)]);
    expect(lines.map((L) => L.items.map((i) => i.x0))).toEqual([[0, 30, 60], [0, 50]]);
  });

  it('разная высота: порог по меньшей', () => {
    const lines = P.groupLines([{ x0: 0, y0: 0, x1: 10, y1: 40 }, { x0: 20, y0: 25, x1: 30, y1: 31 }]);
    expect(lines).toHaveLength(2);
  });
});

describe('recWidth', () => {
  it('пропорционально, не меньше высоты и не больше maxRecW', () => {
    expect(P.recWidth(100, 48)).toBe(100);
    expect(P.recWidth(10, 48)).toBe(48);
    expect(P.recWidth(100000, 10)).toBe(P.CFG.maxRecW);
    expect(P.recWidth(33, 16)).toBe(99);
  });
});

describe('словарь и CTC', () => {
  it('parseDict: CRLF, хвостовой перевод строки, blank в начале', () => {
    expect(P.parseDict('а\r\nб\nв\n')).toEqual(['', 'а', 'б', 'в']);
    expect(P.parseDict('а\nб')).toEqual(['', 'а', 'б']);
  });

  it('fixSpace добавляет пробел, если классов на один больше', () => {
    const cs = ['', 'a', 'b'];
    P.fixSpace(cs, 4); expect(cs).toEqual(['', 'a', 'b', ' ']);
    P.fixSpace(cs, 4); expect(cs).toHaveLength(4);
  });

  it('ctcDecode: схлопывает повторы, blank разделяет, уверенность — среднее', () => {
    const cs = ['', 'a', 'b'];
    const steps = [[0.1, 0.8, 0.1], [0.1, 0.6, 0.3], [0.9, 0.05, 0.05], [0.2, 0.7, 0.1], [0.1, 0.1, 1.0]];
    const r = P.ctcDecode(new Float32Array(steps.flat()), 5, 3, cs);
    expect(r.text).toBe('aab');
    expect(r.n).toBe(3);
    expect(r.conf).toBeCloseTo(((0.8 + 0.7 + 1.0) / 3) * 100, 4);
    expect(P.ctcDecode(new Float32Array([1, 0, 0]), 1, 3, cs)).toEqual({ text: '', conf: 0, n: 0 });
  });

  it('ctcDecode: неизвестный индекс → пусто', () => {
    expect(P.ctcDecode(new Float32Array([0, 0, 0, 1]), 1, 4, ['', 'a']).text).toBe('');
  });

  it('joinLines: пустые рамки пропускаются, уверенность взвешена по символам', () => {
    const r = P.joinLines([
      [{ text: 'ab', conf: 90, n: 2 }, { text: ' ', conf: 10, n: 1 }, { text: 'c', conf: 60, n: 1 }],
      [{ text: '', conf: 0, n: 0 }],
      [{ text: 'd', conf: 30, n: 1 }]
    ]);
    expect(r.text).toBe('ab c\nd');
    expect(r.conf).toBeCloseTo((90 * 2 + 60 + 30) / 4);
    expect(P.joinLines([])).toEqual({ text: '', conf: 0 });
  });
});
