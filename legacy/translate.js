// Перевод встроенным в Chrome Translator API (Chrome 138+, десктоп, локально и бесплатно)
// + LanguageDetector для определения исходного языка.
const Tr = (() => {
  /** Нужна загрузка языкового пакета: create() можно вызвать только по клику пользователя. */
  class NeedDownload extends Error {
    constructor(id, label, spec) {
      super('Нужна загрузка: ' + label);
      this.id = id; this.label = label; this.spec = spec;   // spec: { kind:'detector' } | { kind:'pair', from, to }
    }
  }

  const supported = () => typeof Translator !== 'undefined' && typeof LanguageDetector !== 'undefined';
  let detector = null;
  const translators = new Map();

  const monitorFor = (cb) => (m) => m.addEventListener('downloadprogress', (e) => cb && cb(e.loaded));

  async function ensureDetector(cb) {
    if (!detector) detector = await LanguageDetector.create({ monitor: monitorFor(cb) });
    return detector;
  }

  async function getDetector() {
    if (detector) return detector;
    const av = await LanguageDetector.availability();
    if (av === 'unavailable') throw new Error('Определение языка недоступно в этом браузере');
    if (av === 'available') return ensureDetector();
    try { return await ensureDetector(); }
    catch { throw new NeedDownload('detector', 'модель определения языка', { kind: 'detector' }); }
  }

  async function ensureTranslator(from, to, cb) {
    const k = from + '>' + to;
    if (!translators.has(k)) {
      translators.set(k, await Translator.create({ sourceLanguage: from, targetLanguage: to, monitor: monitorFor(cb) }));
    }
    return translators.get(k);
  }

  async function getTranslator(from, to) {
    const k = from + '>' + to;
    if (translators.has(k)) return translators.get(k);
    let av;
    try { av = await Translator.availability({ sourceLanguage: from, targetLanguage: to }); }
    catch { return null; }
    if (av === 'unavailable') return null;
    if (av === 'available') return ensureTranslator(from, to);
    try { return await ensureTranslator(from, to); }
    catch { throw new NeedDownload(k, `${from} → ${to}`, { kind: 'pair', from, to }); }
  }

  // режем на куски по строкам, чтобы не упереться в лимит ввода
  function chunk(text, max = 1200) {
    const out = [];
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

  /** → { from, state: 'ok'|'same'|'unknown'|'unsupported', text } */
  async function translate(text, target) {
    if (!supported()) throw new Error('Translator API недоступен (нужен Chrome 138+ на десктопе)');
    const sample = text.replace(/\s+/g, ' ').trim().slice(0, 2000);
    const det = await getDetector();
    const top = (await det.detect(sample))[0];
    if (!top || top.detectedLanguage === 'und' || top.confidence < 0.3) return { from: 'und', state: 'unknown', text: '' };

    const from = top.detectedLanguage;
    if (from === target || from.split('-')[0] === target) return { from, state: 'same', text: '' };

    const tr = await getTranslator(from, target);
    if (!tr) return { from, state: 'unsupported', text: '' };

    const parts = [];
    for (const c of chunk(text)) parts.push(await tr.translate(c));
    return { from, state: 'ok', text: parts.join('\n') };
  }

  const warmup = () => getDetector();

  /** Скачать модель. Вызывать из обработчика клика (нужна user activation). */
  function prepare(spec, cb) {
    return spec.kind === 'detector' ? ensureDetector(cb) : ensureTranslator(spec.from, spec.to, cb);
  }

  /** Работает ли перевод в этом контексте (для offscreen-движка это не гарантировано). */
  async function probe() {
    if (!supported()) return false;
    try {
      const av = await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ru' });
      return av !== 'unavailable';
    } catch { return false; }
  }

  const FINAL = ['ok', 'same', 'unknown', 'unsupported'];
  const hasText = (i) => i.status === 'done' && i.text && i.text.trim();
  /** нужно ли (пере)переводить запись — для кнопки «Перевести недостающее» */
  const needs = (i, target) => hasText(i) && (i.tTarget !== target || !FINAL.includes(i.tState));
  /** то же для автоперевода: не долбим записи, которые уже упали с ошибкой или ждут загрузки пакета */
  const needsAuto = (i, target) => hasText(i) && (i.tTarget !== target || !i.tState);

  /** → поля записи, которые нужно записать */
  async function translateRecord(text, target) {
    const base = { tTarget: target, tErr: '', tNeed: null };
    if (!text || !text.trim()) return { ...base, translation: '', tState: 'same' };
    try {
      const r = await translate(text, target);
      return { ...base, lang: r.from, translation: r.text, tState: r.state };
    } catch (e) {
      if (e instanceof NeedDownload) {
        return { ...base, translation: '', tState: 'need-download', tNeed: { id: e.id, label: e.label, spec: e.spec } };
      }
      return { ...base, translation: '', tState: 'error', tErr: e.message || String(e) };
    }
  }

  /** Перевести всё недостающее прямо в базе. post(msg) — оповестить интерфейсы об изменённой записи. */
  async function runMissing(target, { onProgress, post, auto = false } = {}) {
    const test = auto ? needsAuto : needs;
    const todo = (await DB.getAllItems()).filter((i) => test(i, target));
    let n = 0;
    for (const it of todo) {
      onProgress && onProgress(++n, todo.length);
      const patch = await translateRecord(it.text, target);
      const saved = await DB.patchItem(it.key, (r) => Object.assign(r, patch));
      if (saved && post) post({ t: 'item', item: saved });
    }
    return todo.length;
  }

  return { supported, translate, translateRecord, runMissing, prepare, probe, warmup, needs, needsAuto, NeedDownload, _chunk: chunk };
})();
if (typeof module !== 'undefined') module.exports = Tr;
