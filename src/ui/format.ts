// Чистая логика интерфейса: форматирование, фильтры, разметка карточек и истории, строки экспорта.
import type { Cell } from '../shared/xlsx.ts';
import type { EngineState, Entry, Item, Job, Status } from '../shared/types.ts';

export type Mode = 'popup' | 'side' | 'full';
export const PAGE_SIZES: Record<Mode, number> = { popup: 12, side: 20, full: 50 };
export const pageSize = (mode: string | undefined) => PAGE_SIZES[mode as Mode] || 20;

export const IMG_RE = /\.(png|jpe?g|webp|bmp|gif|tiff?|avif)$/i;
export const isImage = (f: File) => f.type.startsWith('image/') || IMG_RE.test(f.name);

export const STATUS: Record<Status, string> = { pending: 'В очереди', processing: 'Обработка…', done: 'Готово', error: 'Ошибка' };
export const ENGINE_LABEL: Record<string, string> = { paddle: 'Paddle', tesseract: 'Tesseract' };

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' с';
  if (s < 3600) return Math.round(s / 60) + ' мин';
  return Math.floor(s / 3600) + ' ч ' + Math.round((s % 3600) / 60) + ' мин';
};
export const fmtDate = (t: number) => new Date(t).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

/** Подпись состояния движка в «пилюле». */
export const pillText = (E: EngineState | null) =>
  !E ? 'движок не запущен' : E.paused ? 'пауза' : E.running ? 'обработка' : 'ожидание';
export const pillClass = (E: EngineState | null) => 'pill ' + (E && E.paused ? 'pause' : E && E.running ? 'run' : '');

export const sortItems = (items: Iterable<Item>) => [...items].sort((a, b) => a.seq - b.seq);

export function counts(items: Iterable<Item>) {
  const c: Record<Status, number> = { pending: 0, processing: 0, done: 0, error: 0 };
  for (const i of items) c[i.status]++;
  return c;
}

/** Ключ задания для фильтров: старые записи без задания → 'none'. */
export const jobKey = (i: Item) => String(i.jobId ?? 'none');

export interface Filter { status: string; query: string; job: string }
export function filterItems(items: Iterable<Item>, { status, query, job }: Filter) {
  const q = query.trim().toLowerCase();
  return sortItems(items).filter((i) => (status === 'all' || i.status === status) &&
    (job === 'all' || jobKey(i) === job) &&
    (!q || i.path.toLowerCase().includes(q) || (i.text || '').toLowerCase().includes(q) ||
      (i.translation || '').toLowerCase().includes(q)));
}

export const natural = (a: Entry, b: Entry) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });

/** Имя задания: общая верхняя папка, имя единственного файла или «N файлов». */
export function jobNameFor(entries: Entry[]) {
  const tops = new Set(entries.map((e) => (e.path.includes('/') ? e.path.split('/')[0] : '')));
  if (tops.size === 1 && [...tops][0]) return [...tops][0]!;
  return entries.length === 1 ? entries[0]!.path : `${entries.length} файлов`;
}

/** Ячейка «перевод» в карточке. */
export function tCell(i: Item) {
  if (i.translation) return esc(i.translation);
  if (i.status !== 'done') return '';
  const m = ({
    'need-download': '⏳ ждёт языкового пакета',
    same: i.tTarget ? '— уже на целевом языке' : '',
    unknown: '— язык не определён',
    unsupported: `— пара ${esc(i.lang)} → ${esc(i.tTarget)} не поддерживается`,
    error: esc(i.tErr)
  } as Record<string, string>)[i.tState ?? ''];
  return m ? `<span class="muted">${m}</span>` : '';
}

export function cardHtml(i: Item, job: Job | undefined) {
  const eng = i.status === 'done' ? ` · ${ENGINE_LABEL[i.engine ?? ''] || ''} ${Math.round(i.conf || 0)}%` : '';
  const lang = i.lang && i.lang !== 'und' ? ` · ${esc(i.lang)}` : '';
  const text = i.status === 'error'
    ? `<span class="err">${esc(i.error)}</span>`
    : esc(i.text || '') + (i.warn ? `<div class="warn">${esc(i.warn)}</div>` : '');
  const canRedo = i.hasBlob && i.status !== 'processing';
  return `<article class="card st-${i.status}" data-key="${esc(i.key)}">` +
    (i.thumb ? `<img class="thumb" data-act="img" src="${esc(i.thumb)}" alt="" title="Открыть картинку">` : '<div class="thumb"></div>') +
    `<div><div class="fname">${esc(i.path)}</div><div class="sub">№${i.seq} · <span class="stt">${STATUS[i.status]}</span>${eng}${lang}` +
    `${job && job.name ? ' · ' + esc(job.name) : ''}</div></div>` +
    `<div class="cols"><div class="txt">${text}</div><div class="txt">${tCell(i)}</div></div>` +
    `<div class="btns"><button data-act="redo" ${canRedo ? '' : 'disabled title="Картинка не сохранена или обрабатывается"'}>Переделать</button>` +
    `<button data-act="copy" ${i.text ? '' : 'disabled'}>Копировать</button></div></article>`;
}

export interface JobStat { total: number; done: number; error: number; open: number; ms: number; noBlob: number }

export function jobStats(items: Iterable<Item>) {
  const m = new Map<number | 'none', JobStat>();
  for (const i of items) {
    const id = i.jobId ?? 'none';
    const s = m.get(id) || { total: 0, done: 0, error: 0, open: 0, ms: 0, noBlob: 0 };
    s.total++;
    if (i.status === 'done') s.done++; else if (i.status === 'error') s.error++; else s.open++;
    s.ms += i.ms || 0;
    if (!i.hasBlob) s.noBlob++;
    m.set(id, s);
  }
  return m;
}

type HistoryJob = Omit<Job, 'id' | 'total' | 'startedAt' | 'finishedAt'> & Partial<Omit<Job, 'id'>> & { id: number | 'none' };

export function historyHtml(jobs: Iterable<Job>, items: Iterable<Item>) {
  const stats = jobStats(items);
  const list: HistoryJob[] = [...jobs].sort((a, b) => b.createdAt - a.createdAt);
  if (stats.has('none')) list.push({ id: 'none', name: 'Без задания (старые записи)', createdAt: 0 });
  if (!list.length) return '<p class="hint">Пока пусто.</p>';
  return list.map((j) => {
    const s = stats.get(j.id) || { total: 0, done: 0, error: 0, open: 0, ms: 0 };
    const real = j.id !== 'none';
    const state = j.finishedAt ? 'завершено' : s.open ? 'в работе' : '';
    const dur = j.startedAt && j.finishedAt ? fmtDur(j.finishedAt - j.startedAt) : s.ms ? '≈ ' + fmtDur(s.ms) : '—';
    return `<div class="job" data-job="${j.id}"><div class="jh"><b>${esc(j.name || 'Задание')}</b>` +
      `<span class="sub">${j.createdAt ? fmtDate(j.createdAt) : ''}</span></div>` +
      `<div class="sub">Файлов ${s.total} · готово ${s.done} · ошибок ${s.error}` +
      `${s.open ? ' · в очереди ' + s.open : ''} · время ${dur}${state ? ' · ' + state : ''}</div>` +
      `<div class="btns"><button data-jact="show">Показать</button><button data-jact="export">Экспорт</button>` +
      (real ? `<button data-jact="redo">Переделать</button><button data-jact="delete" class="danger">Удалить</button>` : '') +
      `</div></div>`;
  }).join('');
}

export function jobOptionsHtml(jobs: Iterable<Job>) {
  return '<option value="all">Все задания</option>' +
    [...jobs].sort((a, b) => b.createdAt - a.createdAt)
      .map((j) => `<option value="${j.id}">${esc(j.name || 'Задание')} · ${fmtDate(j.createdAt)}</option>`).join('');
}

const T_LABEL: Record<string, string> = {
  'need-download': 'перевод не выполнен: нужен языковой пакет', same: 'уже на целевом языке',
  unknown: 'язык не определён', unsupported: 'пара языков не поддерживается'
};

export const EXPORT_HEADER = ['№', 'Файл', 'Задание', 'Дата', 'Статус', 'Движок', 'Уверенность, %', 'Язык', 'Текст', 'Перевод', 'Примечание'];
export const EXPORT_WIDTHS = [6, 36, 20, 16, 10, 12, 14, 8, 60, 60, 30];

/** Строки для .xlsx: только готовые/ошибочные; jobId — фильтр по заданию (число, строка или 'none'). */
export function exportRows(items: Iterable<Item>, jobs: Map<number, Job>, jobId?: number | string): Cell[][] {
  const rows: Cell[][] = [EXPORT_HEADER];
  for (const i of sortItems(items)) {
    if (i.status !== 'done' && i.status !== 'error') continue;
    if (jobId !== undefined && jobKey(i) !== String(jobId)) continue;
    const job = i.jobId != null ? jobs.get(i.jobId) : undefined;
    const notes = [i.error, i.warn, i.tState === 'error' ? 'ошибка перевода: ' + i.tErr : (i.translation ? '' : T_LABEL[i.tState ?? ''])]
      .filter(Boolean).join('; ');
    rows.push([i.seq, i.path, job ? job.name : '', i.doneAt ? fmtDate(i.doneAt) : '', STATUS[i.status], ENGINE_LABEL[i.engine ?? ''] || '',
      i.conf != null ? Math.round(i.conf * 10) / 10 : '', i.lang && i.lang !== 'und' ? i.lang : '',
      i.text || '', i.translation || '', notes]);
  }
  return rows;
}

export const exportFileName = (d = new Date()) => `ocr-${d.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.xlsx`;
