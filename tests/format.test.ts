import { describe, expect, it } from 'vitest';
import * as F from '../src/ui/format.ts';
import { entry, item, job } from './helpers/data.ts';

describe('мелочи', () => {
  it('pageSize', () => {
    expect([F.pageSize('popup'), F.pageSize('side'), F.pageSize('full'), F.pageSize(undefined), F.pageSize('x')]).toEqual([12, 20, 50, 20, 20]);
  });

  it('isImage по MIME или расширению', () => {
    expect(F.isImage(new File([''], 'a.txt', { type: 'image/png' }))).toBe(true);
    expect(F.isImage(new File([''], 'scan.TIFF'))).toBe(true);
    expect(F.isImage(new File([''], 'a.jpeg'))).toBe(true);
    expect(F.isImage(new File([''], 'a.pdf', { type: 'application/pdf' }))).toBe(false);
  });

  it('esc', () => {
    expect(F.esc('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    expect(F.esc(null)).toBe('');
    expect(F.esc(0)).toBe('0');
  });

  it('fmtDur', () => {
    expect([F.fmtDur(400), F.fmtDur(59_000), F.fmtDur(90_000), F.fmtDur(3_600_000), F.fmtDur(5_430_000)])
      .toEqual(['0 с', '59 с', '2 мин', '1 ч 0 мин', '1 ч 31 мин']);
  });

  it('pill', () => {
    const E = { paused: false, running: false, current: null, remaining: 0, sessionDone: 0, sessionMs: 0, canTranslate: false };
    expect(F.pillText(null)).toBe('движок не запущен');
    expect(F.pillText({ ...E, paused: true, running: true })).toBe('пауза');
    expect(F.pillText({ ...E, running: true })).toBe('обработка');
    expect(F.pillText(E)).toBe('ожидание');
    expect([F.pillClass(null), F.pillClass({ ...E, paused: true }), F.pillClass({ ...E, running: true })]).toEqual(['pill ', 'pill pause', 'pill run']);
  });

  it('jobNameFor', () => {
    expect(F.jobNameFor([entry('scans/1.png'), entry('scans/sub/2.png')])).toBe('scans');
    expect(F.jobNameFor([entry('one.png')])).toBe('one.png');
    expect(F.jobNameFor([entry('a/1.png'), entry('b/2.png')])).toBe('2 файлов');
    expect(F.jobNameFor([entry('1.png'), entry('2.png'), entry('3.png')])).toBe('3 файлов');
  });

  it('natural: числа по значению, регистр не важен', () => {
    const list = ['img10.png', 'IMG2.png', 'img1.png'].map((p) => entry(p));
    expect(list.sort(F.natural).map((e) => e.path)).toEqual(['img1.png', 'IMG2.png', 'img10.png']);
  });

  it('exportFileName', () => {
    expect(F.exportFileName(new Date('2026-11-11T08:05:00Z'))).toBe('ocr-2026-11-11-08-05.xlsx');
  });
});

describe('списки', () => {
  const items = [
    item({ key: 'c', seq: 3, status: 'error', jobId: 2, path: 'C.png', error: 'x' }),
    item({ key: 'a', seq: 1, status: 'done', jobId: 1, path: 'dir/A.png', text: 'Привет мир' }),
    item({ key: 'b', seq: 2, status: 'pending', jobId: 1, path: 'B.png', translation: 'Hello' }),
    item({ key: 'd', seq: 4, status: 'processing', jobId: null, path: 'old.png', hasBlob: false })
  ];

  it('counts и sortItems', () => {
    expect(F.counts(items)).toEqual({ pending: 1, processing: 1, done: 1, error: 1 });
    expect(F.sortItems(items).map((i) => i.key)).toEqual(['a', 'b', 'c', 'd']);
  });

  it.each([
    [{ status: 'all', query: '', job: 'all' }, ['a', 'b', 'c', 'd']],
    [{ status: 'done', query: '', job: 'all' }, ['a']],
    [{ status: 'all', query: '', job: '1' }, ['a', 'b']],
    [{ status: 'all', query: '', job: 'none' }, ['d']],
    [{ status: 'all', query: ' МИР ', job: 'all' }, ['a']],
    [{ status: 'all', query: 'hello', job: 'all' }, ['b']],
    [{ status: 'all', query: 'dir/', job: 'all' }, ['a']],
    [{ status: 'pending', query: 'a', job: '2' }, []]
  ])('filterItems %o', (f, want) => expect(F.filterItems(items, f).map((i) => i.key)).toEqual(want));

  it('jobStats', () => {
    const s = F.jobStats([...items, item({ key: 'e', seq: 5, status: 'done', jobId: 1, ms: 1500 })]);
    expect(s.get(1)).toEqual({ total: 3, done: 2, error: 0, open: 1, ms: 1500, noBlob: 0 });
    expect(s.get('none')).toEqual({ total: 1, done: 0, error: 0, open: 1, ms: 0, noBlob: 1 });
  });
});

describe('разметка', () => {
  it('tCell', () => {
    const d = (p: object) => item({ key: 'k', status: 'done', ...p });
    expect(F.tCell(d({ translation: '<b>' }))).toBe('&lt;b&gt;');
    expect(F.tCell(item({ key: 'k' }))).toBe('');
    expect(F.tCell(d({ tState: 'need-download' }))).toBe('<span class="muted">⏳ ждёт языкового пакета</span>');
    expect(F.tCell(d({ tState: 'same', tTarget: 'ru' }))).toBe('<span class="muted">— уже на целевом языке</span>');
    expect(F.tCell(d({ tState: 'same' }))).toBe('');
    expect(F.tCell(d({ tState: 'unsupported', lang: 'xx', tTarget: 'ru' }))).toContain('пара xx → ru');
    expect(F.tCell(d({ tState: 'error', tErr: '<oops>' }))).toBe('<span class="muted">&lt;oops&gt;</span>');
    expect(F.tCell(d({ tState: '' }))).toBe('');
  });

  it('cardHtml: экранирование, состояние кнопок, подписи', () => {
    const html = F.cardHtml(item({ key: 'k"1', seq: 7, status: 'done', path: '<x>.png', engine: 'paddle', conf: 87.6, lang: 'en', text: 'T', thumb: 'data:a' }), job({ id: 1, name: 'Мой' }));
    expect(html).toContain('data-key="k&quot;1"');
    expect(html).toContain('<div class="fname">&lt;x&gt;.png</div>');
    expect(html).toContain('№7 · <span class="stt">Готово</span> · Paddle 88% · en · Мой');
    expect(html).toContain('<img class="thumb" data-act="img" src="data:a"');
    expect(html).toContain('<button data-act="redo" >Переделать</button>');
    expect(html).toContain('<button data-act="copy" >Копировать</button>');

    const err = F.cardHtml(item({ key: 'e', status: 'error', error: 'плохо', hasBlob: false }), undefined);
    expect(err).toContain('<span class="err">плохо</span>');
    expect(err).toContain('<div class="thumb"></div>');
    expect(err).toContain('data-act="redo" disabled');
    expect(err).toContain('data-act="copy" disabled');

    expect(F.cardHtml(item({ key: 'p', status: 'processing' }), undefined)).toContain('data-act="redo" disabled');
    expect(F.cardHtml(item({ key: 'w', status: 'done', text: 'a', warn: 'Tesseract: x', lang: 'und' }), undefined))
      .toMatch(/a<div class="warn">Tesseract: x<\/div>/);
  });

  it('historyHtml: сортировка, старые записи, длительность', () => {
    const jobs = [job({ id: 100, name: 'Первое', createdAt: 100, startedAt: 1000, finishedAt: 61_000 }), job({ id: 200, name: '', createdAt: 200 })];
    const items = [
      item({ key: 'a', jobId: 100, status: 'done' }), item({ key: 'b', jobId: 200, status: 'pending', ms: 2000 }),
      item({ key: 'c', jobId: null, status: 'error' })
    ];
    const html = F.historyHtml(jobs, items);
    expect(html.indexOf('data-job="200"')).toBeLessThan(html.indexOf('data-job="100"'));
    expect(html).toContain('<b>Задание</b>');
    expect(html).toContain('Файлов 1 · готово 1 · ошибок 0 · время 1 мин · завершено');
    expect(html).toContain('Файлов 1 · готово 0 · ошибок 0 · в очереди 1 · время ≈ 2 с · в работе');
    expect(html).toContain('Без задания (старые записи)');
    const none = html.slice(html.indexOf('data-job="none"'));
    expect(none).not.toContain('data-jact="delete"');
    expect(F.historyHtml([], [])).toBe('<p class="hint">Пока пусто.</p>');
  });

  it('jobOptionsHtml', () => {
    const html = F.jobOptionsHtml([job({ id: 1, name: 'a<b', createdAt: 1 }), job({ id: 2, name: 'b', createdAt: 2 })]);
    expect(html.startsWith('<option value="all">Все задания</option><option value="2">b · ')).toBe(true);
    expect(html).toContain('a&lt;b');
  });
});

describe('exportRows', () => {
  const jobs = new Map([[1, job({ id: 1, name: 'Пачка' })]]);
  const items = [
    item({ key: 'b', seq: 2, status: 'error', error: 'сбой', jobId: 1 }),
    item({ key: 'a', seq: 1, status: 'done', jobId: 1, path: 'a.png', engine: 'tesseract', conf: 87.66, lang: 'en', text: 'T',
      translation: 'П', tState: 'ok', doneAt: Date.UTC(2026, 0, 2, 3, 4), warn: 'w' }),
    item({ key: 'c', seq: 3, status: 'pending', jobId: 1 }),
    item({ key: 'd', seq: 4, status: 'done', jobId: null, text: 'x', lang: 'und', tState: 'need-download' }),
    item({ key: 'e', seq: 5, status: 'done', jobId: 1, text: 'y', tState: 'error', tErr: 'нет сети' })
  ];

  it('шапка, порядок, фильтр по статусу, заметки', () => {
    const rows = F.exportRows(items, jobs);
    expect(rows[0]).toEqual(F.EXPORT_HEADER);
    expect(rows.slice(1).map((r) => r[0])).toEqual([1, 2, 4, 5]);
    expect(rows[1]).toEqual([1, 'a.png', 'Пачка', F.fmtDate(Date.UTC(2026, 0, 2, 3, 4)), 'Готово', 'Tesseract', 87.7, 'en', 'T', 'П', 'w']);
    expect(rows[2]).toEqual([2, 'b', 'Пачка', '', 'Ошибка', '', '', '', '', '', 'сбой']);
    expect(rows[3]![2]).toBe('');
    expect(rows[3]![7]).toBe('');
    expect(rows[3]![10]).toBe('перевод не выполнен: нужен языковой пакет');
    expect(rows[4]![10]).toBe('ошибка перевода: нет сети');
  });

  it('фильтр по заданию: число, строка, none', () => {
    expect(F.exportRows(items, jobs, 1).length - 1).toBe(3);
    expect(F.exportRows(items, jobs, '1').length - 1).toBe(3);
    expect(F.exportRows(items, jobs, 'none').map((r) => r[0])).toEqual(['№', 4]);
  });
});
