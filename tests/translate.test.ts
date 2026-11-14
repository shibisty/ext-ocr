import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as DB from '../src/shared/db.ts';
import * as Tr from '../src/shared/translate.ts';
import { entry, item } from './helpers/data.ts';

type Av = 'unavailable' | 'downloadable' | 'downloading' | 'available';

/** Подделка Translator / LanguageDetector. */
function installAi(o: {
  detAv?: Av; detCreateFails?: boolean; lang?: string; conf?: number;
  pairAv?: (from: string, to: string) => Av; pairCreateFails?: boolean; availabilityThrows?: boolean;
} = {}) {
  const translateCalls: string[] = [];
  const g = globalThis as Record<string, unknown>;
  g.LanguageDetector = {
    availability: vi.fn(async () => o.detAv ?? 'available'),
    create: vi.fn(async ({ monitor }: { monitor?: (m: EventTarget) => void } = {}) => {
      const m = new EventTarget();
      monitor?.(m);
      m.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 0.5 }));
      if (o.detCreateFails) throw new Error('NotAllowedError');
      return { detect: vi.fn(async () => (o.lang === undefined ? [] : [{ detectedLanguage: o.lang, confidence: o.conf ?? 0.9 }])) };
    })
  };
  g.Translator = {
    availability: vi.fn(async ({ sourceLanguage, targetLanguage }: { sourceLanguage: string; targetLanguage: string }) => {
      if (o.availabilityThrows) throw new Error('bad lang');
      return o.pairAv ? o.pairAv(sourceLanguage, targetLanguage) : 'available';
    }),
    create: vi.fn(async ({ sourceLanguage, targetLanguage }: { sourceLanguage: string; targetLanguage: string }) => {
      if (o.pairCreateFails) throw new Error('NotAllowedError');
      return { translate: vi.fn(async (t: string) => { translateCalls.push(t); return `[${sourceLanguage}>${targetLanguage}]${t}`; }) };
    })
  };
  return { translateCalls, det: g.LanguageDetector as { create: ReturnType<typeof vi.fn> } };
}

beforeEach(() => Tr._reset());
afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.Translator;
  delete g.LanguageDetector;
});

describe('chunk', () => {
  it('короткий текст — один кусок', () => {
    expect(Tr.chunk('a\nb')).toEqual(['a\nb']);
    expect(Tr.chunk('')).toEqual([]);
  });

  it('режет по строкам, не превышая лимит', () => {
    const out = Tr.chunk('aaaa\nbbbb\ncccc', 9);
    expect(out).toEqual(['aaaa\nbbbb', 'cccc']);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(9);
  });

  it('длинную строку режет по пробелу, а без пробелов — жёстко', () => {
    expect(Tr.chunk('hello world foo', 12)).toEqual(['hello world', 'foo']);
    expect(Tr.chunk('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('склейка кусков восстанавливает текст (с точностью до пробелов на разрезах)', () => {
    const words = Array.from({ length: 2000 }, (_, i) => `слово${i}` + (i % 17 === 0 ? '\n' : ' ')).join('');
    const parts = Tr.chunk(words, 1200);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(1200);
    expect(parts.join(' ').replace(/\s+/g, ' ').trim()).toBe(words.replace(/\s+/g, ' ').trim());
  });
});

describe('translate', () => {
  it('без API — ошибка, supported/probe = false', async () => {
    expect(Tr.supported()).toBe(false);
    expect(await Tr.probe()).toBe(false);
    await expect(Tr.translate('x', 'ru')).rejects.toThrow(/Chrome 138/);
  });

  it('язык не определён', async () => {
    installAi({ lang: 'und' });
    expect(await Tr.translate('???', 'ru')).toEqual({ from: 'und', state: 'unknown', text: '' });
    Tr._reset(); installAi({ lang: 'en', conf: 0.1 });
    expect((await Tr.translate('x', 'ru')).state).toBe('unknown');
    Tr._reset(); installAi({});
    expect((await Tr.translate('x', 'ru')).state).toBe('unknown');
  });

  it('уже на целевом языке (в том числе с регионом)', async () => {
    installAi({ lang: 'ru' });
    expect(await Tr.translate('привет', 'ru')).toEqual({ from: 'ru', state: 'same', text: '' });
    Tr._reset(); installAi({ lang: 'en-GB' });
    expect((await Tr.translate('hello', 'en')).state).toBe('same');
  });

  it('пара не поддерживается или availability бросает', async () => {
    installAi({ lang: 'en', pairAv: () => 'unavailable' });
    expect(await Tr.translate('hello', 'ru')).toEqual({ from: 'en', state: 'unsupported', text: '' });
    Tr._reset(); installAi({ lang: 'en', availabilityThrows: true });
    expect((await Tr.translate('hello', 'ru')).state).toBe('unsupported');
  });

  it('переводит кусками и кэширует переводчик', async () => {
    const ai = installAi({ lang: 'en' });
    const text = ('line '.repeat(100) + '\n').repeat(6);   // ~3000 символов → несколько кусков
    const r = await Tr.translate(text, 'ru');
    expect(r.state).toBe('ok');
    expect(ai.translateCalls.length).toBeGreaterThan(1);
    expect(r.text).toBe(Tr.chunk(text).map((c) => '[en>ru]' + c).join('\n'));
    await Tr.translate('more', 'ru');
    const T = (globalThis as unknown as { Translator: { create: ReturnType<typeof vi.fn> } }).Translator;
    expect(T.create).toHaveBeenCalledTimes(1);
  });

  it('нужна загрузка детектора → NeedDownload', async () => {
    installAi({ lang: 'en', detAv: 'downloadable', detCreateFails: true });
    const e = await Tr.translate('hello', 'ru').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Tr.NeedDownload);
    expect(e).toMatchObject({ id: 'detector', spec: { kind: 'detector' } });
  });

  it('детектор недоступен совсем — обычная ошибка', async () => {
    installAi({ detAv: 'unavailable' });
    await expect(Tr.translate('x', 'ru')).rejects.toThrow('Определение языка недоступно');
  });

  it('нужна загрузка пары → NeedDownload с id from>to', async () => {
    installAi({ lang: 'de', pairAv: () => 'downloadable', pairCreateFails: true });
    const e = await Tr.translate('Hallo', 'ru').catch((x: unknown) => x);
    expect(e).toMatchObject({ id: 'de>ru', label: 'de → ru', spec: { kind: 'pair', from: 'de', to: 'ru' } });
  });

  it('prepare скачивает модель и сообщает прогресс', async () => {
    installAi({ lang: 'en' });
    const cb = vi.fn();
    await Tr.prepare({ kind: 'detector' }, cb);
    expect(cb).toHaveBeenCalledWith(0.5);
    await Tr.prepare({ kind: 'pair', from: 'en', to: 'ru' });
  });

  it('probe', async () => {
    installAi({ pairAv: () => 'downloadable' });
    expect(await Tr.probe()).toBe(true);
    installAi({ pairAv: () => 'unavailable' });
    expect(await Tr.probe()).toBe(false);
    installAi({ availabilityThrows: true });
    expect(await Tr.probe()).toBe(false);
  });
});

describe('translateRecord', () => {
  it('пустой текст → same', async () => {
    expect(await Tr.translateRecord('  ', 'ru')).toEqual({ tTarget: 'ru', tErr: '', tNeed: null, translation: '', tState: 'same' });
    expect(await Tr.translateRecord(undefined, 'ru')).toMatchObject({ tState: 'same' });
  });

  it('успех, загрузка, ошибка', async () => {
    installAi({ lang: 'en' });
    expect(await Tr.translateRecord('hi', 'ru')).toEqual({ tTarget: 'ru', tErr: '', tNeed: null, lang: 'en', translation: '[en>ru]hi', tState: 'ok' });

    Tr._reset(); installAi({ lang: 'de', pairAv: () => 'downloading', pairCreateFails: true });
    expect(await Tr.translateRecord('Hallo', 'ru')).toMatchObject({
      tState: 'need-download', translation: '', tNeed: { id: 'de>ru', label: 'de → ru', spec: { kind: 'pair', from: 'de', to: 'ru' } }
    });

    Tr._reset();
    delete (globalThis as Record<string, unknown>).Translator;
    expect(await Tr.translateRecord('x', 'ru')).toMatchObject({ tState: 'error', tErr: expect.stringContaining('Translator API') });
  });
});

describe('needs / needsAuto', () => {
  const done = (p = {}) => item({ key: 'k', status: 'done', text: 'abc', ...p });
  it.each([
    ['не готово', item({ key: 'k', text: 'x' }), false, false],
    ['пустой текст', done({ text: '  ' }), false, false],
    ['не переводили', done(), true, true],
    ['другой язык', done({ tTarget: 'en', tState: 'ok' }), true, true],
    ['готово', done({ tTarget: 'ru', tState: 'ok' }), false, false],
    ['ошибка', done({ tTarget: 'ru', tState: 'error' }), true, false],
    ['ждёт пакета', done({ tTarget: 'ru', tState: 'need-download' }), true, false],
    ['unsupported — финал', done({ tTarget: 'ru', tState: 'unsupported' }), false, false]
  ])('%s', (_n, it_, needs, auto) => {
    expect(Tr.needs(it_, 'ru')).toBe(needs);
    expect(Tr.needsAuto(it_, 'ru')).toBe(auto);
  });
});

describe('runMissing', () => {
  it('переводит нужные записи в базе и оповещает', async () => {
    installAi({ lang: 'en' });
    await DB.enqueue([entry('a.png'), entry('b.png'), entry('c.png')]);
    const [a, b, c] = (await DB.getAllItems()).sort((x, y) => x.seq - y.seq);
    await DB.patchItem(a!.key, (r) => Object.assign(r, { status: 'done', text: 'one' }));
    await DB.patchItem(b!.key, (r) => Object.assign(r, { status: 'done', text: 'two', tTarget: 'ru', tState: 'error' }));
    await DB.patchItem(c!.key, (r) => Object.assign(r, { status: 'done', text: 'three', tTarget: 'ru', tState: 'ok', translation: 'три' }));

    const post = vi.fn(), progress = vi.fn();
    expect(await Tr.runMissing('ru', { auto: true, post, onProgress: progress })).toBe(1);
    expect(post).toHaveBeenCalledWith({ t: 'item', item: expect.objectContaining({ key: a!.key, translation: '[en>ru]one' }) });
    expect(progress.mock.calls).toEqual([[1, 1]]);

    expect(await Tr.runMissing('ru', { post })).toBe(1);   // вручную — и ошибочную
    expect((await DB.getItem(b!.key))!.translation).toBe('[en>ru]two');
    expect((await DB.getItem(c!.key))!.translation).toBe('три');
  });
});
