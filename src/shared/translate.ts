// Перевод встроенным в Chrome Translator API (Chrome 138+, десктоп, локально и бесплатно)
// + LanguageDetector для определения исходного языка.
import * as DB from './db.ts';
import type { BusMessage, Item, NeedSpec, TState } from './types.ts';

// ---------- минимальные типы встроенных API (в lib.dom их может не быть) ----------
type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
interface DownloadMonitor extends EventTarget {}
type MonitorFn = (m: DownloadMonitor) => void;
interface DetectorInstance { detect(text: string): Promise<{ detectedLanguage: string; confidence: number }[]> }
interface TranslatorInstance { translate(text: string): Promise<string> }
interface DetectorStatic {
  availability(): Promise<Availability>;
  create(o?: { monitor?: MonitorFn }): Promise<DetectorInstance>;
}
interface TranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(o: { sourceLanguage: string; targetLanguage: string; monitor?: MonitorFn }): Promise<TranslatorInstance>;
}
interface AiGlobals { Translator?: TranslatorStatic; LanguageDetector?: DetectorStatic }
const ai = () => globalThis as unknown as AiGlobals;
const T = () => ai().Translator!;
const LD = () => ai().LanguageDetector!;

/** Нужна загрузка языкового пакета: create() можно вызвать только по клику пользователя. */
export class NeedDownload extends Error {
  constructor(readonly id: string, readonly label: string, readonly spec: NeedSpec) {
    super('Нужна загрузка: ' + label);
  }
}

export const supported = () => typeof ai().Translator !== 'undefined' && typeof ai().LanguageDetector !== 'undefined';

let detector: DetectorInstance | null = null;
const translators = new Map<string, TranslatorInstance>();

/** Сбросить кэш моделей (для тестов). */
export function _reset() { detector = null; translators.clear(); }

type ProgressCb = (loaded: number) => void;
const monitorFor = (cb?: ProgressCb): MonitorFn => (m) =>
  m.addEventListener('downloadprogress', (e) => cb && cb((e as ProgressEvent).loaded));

async function ensureDetector(cb?: ProgressCb) {
  if (!detector) detector = await LD().create({ monitor: monitorFor(cb) });
  return detector;
}

async function getDetector() {
  if (detector) return detector;
  const av = await LD().availability();
  if (av === 'unavailable') throw new Error('Определение языка недоступно в этом браузере');
  if (av === 'available') return ensureDetector();
  try { return await ensureDetector(); }
  catch { throw new NeedDownload('detector', 'модель определения языка', { kind: 'detector' }); }
}

async function ensureTranslator(from: string, to: string, cb?: ProgressCb) {
  const k = from + '>' + to;
  if (!translators.has(k)) {
    translators.set(k, await T().create({ sourceLanguage: from, targetLanguage: to, monitor: monitorFor(cb) }));
  }
  return translators.get(k)!;
}

async function getTranslator(from: string, to: string) {
  const k = from + '>' + to;
  if (translators.has(k)) return translators.get(k)!;
  let av: Availability;
  try { av = await T().availability({ sourceLanguage: from, targetLanguage: to }); }
  catch { return null; }
  if (av === 'unavailable') return null;
  if (av === 'available') return ensureTranslator(from, to);
  try { return await ensureTranslator(from, to); }
  catch { throw new NeedDownload(k, `${from} → ${to}`, { kind: 'pair', from, to }); }
}

/** Режем на куски по строкам, чтобы не упереться в лимит ввода. */
export function chunk(text: string, max = 1200): string[] {
  const out: string[] = [];
  let cur = '';
  const push = () => { if (cur) { out.push(cur); cur = ''; } };
  for (let line of text.split('\n')) {
    while (line.length > max) {
      let cut = line.lastIndexOf(' ', max);
      if (cut < max * 0.5) cut = max;
      push();
      out.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    if (cur && cur.length + line.length + 1 > max) push();
    cur += (cur ? '\n' : '') + line;
  }
  push();
  return out;
}

export interface TranslateResult { from: string; state: 'ok' | 'same' | 'unknown' | 'unsupported'; text: string }

export async function translate(text: string, target: string): Promise<TranslateResult> {
  if (!supported()) throw new Error('Translator API недоступен (нужен Chrome 138+ на десктопе)');
  const sample = text.replace(/\s+/g, ' ').trim().slice(0, 2000);
  const det = await getDetector();
  const top = (await det.detect(sample))[0];
  if (!top || top.detectedLanguage === 'und' || top.confidence < 0.3) return { from: 'und', state: 'unknown', text: '' };

  const from = top.detectedLanguage;
  if (from === target || from.split('-')[0] === target) return { from, state: 'same', text: '' };

  const tr = await getTranslator(from, target);
  if (!tr) return { from, state: 'unsupported', text: '' };

  const parts: string[] = [];
  for (const c of chunk(text)) parts.push(await tr.translate(c));
  return { from, state: 'ok', text: parts.join('\n') };
}

export const warmup = () => getDetector();

/** Скачать модель. Вызывать из обработчика клика (нужна user activation). */
export function prepare(spec: NeedSpec, cb?: ProgressCb) {
  return spec.kind === 'detector' ? ensureDetector(cb) : ensureTranslator(spec.from, spec.to, cb);
}

/** Работает ли перевод в этом контексте (для offscreen-движка это не гарантировано). */
export async function probe(): Promise<boolean> {
  if (!supported()) return false;
  try {
    const av = await T().availability({ sourceLanguage: 'en', targetLanguage: 'ru' });
    return av !== 'unavailable';
  } catch { return false; }
}

const FINAL: readonly TState[] = ['ok', 'same', 'unknown', 'unsupported'];
const hasText = (i: Item) => !!(i.status === 'done' && i.text && i.text.trim());
/** нужно ли (пере)переводить запись — для кнопки «Перевести недостающее» */
export const needs = (i: Item, target: string) => hasText(i) && (i.tTarget !== target || !FINAL.includes(i.tState ?? ''));
/** то же для автоперевода: не долбим записи, которые уже упали с ошибкой или ждут загрузки пакета */
export const needsAuto = (i: Item, target: string) => hasText(i) && (i.tTarget !== target || !i.tState);

export type TranslationPatch = Pick<Item, 'tTarget' | 'tErr' | 'tNeed' | 'translation' | 'tState'> & Partial<Pick<Item, 'lang'>>;

/** → поля записи, которые нужно записать */
export async function translateRecord(text: string | undefined, target: string): Promise<TranslationPatch> {
  const base = { tTarget: target, tErr: '', tNeed: null };
  if (!text || !text.trim()) return { ...base, translation: '', tState: 'same' };
  try {
    const r = await translate(text, target);
    return { ...base, lang: r.from, translation: r.text, tState: r.state };
  } catch (e) {
    if (e instanceof NeedDownload) {
      return { ...base, translation: '', tState: 'need-download', tNeed: { id: e.id, label: e.label, spec: e.spec } };
    }
    return { ...base, translation: '', tState: 'error', tErr: (e as Error)?.message || String(e) };
  }
}

export interface RunMissingOptions {
  onProgress?: (n: number, total: number) => void;
  post?: (m: Extract<BusMessage, { t: 'item' }>) => void;
  auto?: boolean;
}

/** Перевести всё недостающее прямо в базе. post(msg) — оповестить интерфейсы об изменённой записи. */
export async function runMissing(target: string, { onProgress, post, auto = false }: RunMissingOptions = {}) {
  const test = auto ? needsAuto : needs;
  const todo = (await DB.getAllItems()).filter((i) => test(i, target));
  let n = 0;
  for (const it of todo) {
    onProgress?.(++n, todo.length);
    const patch = await translateRecord(it.text, target);
    const saved = await DB.patchItem(it.key, (r) => Object.assign(r, patch));
    if (saved && post) post({ t: 'item', item: saved });
  }
  return todo.length;
}
