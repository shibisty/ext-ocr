// Простейший canvas для node: getImageData отдаёт заданный цвет, putImageData запоминает результат.
import { vi } from 'vitest';

export interface FakeCanvas { width: number; height: number; ctx: FakeCtx; toDataURL: () => string; getContext: () => FakeCtx }
export interface FakeCtx {
  fillStyle: string;
  fillRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray };
  putImageData: ReturnType<typeof vi.fn>;
}

export function installCanvas(pixel: (i: number) => [number, number, number] = () => [128, 128, 128]) {
  const made: FakeCanvas[] = [];
  const createElement = vi.fn((tag: string) => {
    if (tag !== 'canvas') throw new Error('unexpected ' + tag);
    const c = { width: 0, height: 0 } as FakeCanvas;
    c.ctx = {
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: (_x, _y, w, h) => {
        const d = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) { const [r, g, b] = pixel(i); d.set([r, g, b, 255], i * 4); }
        return { data: d };
      },
      putImageData: vi.fn()
    };
    c.getContext = () => c.ctx;
    c.toDataURL = () => 'data:image/jpeg;base64,AAA';
    made.push(c);
    return c;
  });
  (globalThis as unknown as { document: unknown }).document = { createElement };
  return { made, createElement };
}

export const bitmap = (width: number, height: number) => ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;
