import { describe, expect, it } from 'vitest';
import * as X from '../src/shared/xlsx.ts';
import { unzip } from './helpers/unzip.ts';

const enc = new TextEncoder(), dec = new TextDecoder();
const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

describe('crc32', () => {
  it('эталонные значения', () => {
    expect(X.crc32(enc.encode('123456789'))).toBe(0xCBF43926);
    expect(X.crc32(new Uint8Array())).toBe(0);
    expect(X.crc32(enc.encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414FA339);
  });
});

describe('colName', () => {
  it.each([[0, 'A'], [1, 'B'], [25, 'Z'], [26, 'AA'], [27, 'AB'], [51, 'AZ'], [52, 'BA'], [701, 'ZZ'], [702, 'AAA'], [16383, 'XFD']])(
    '%i → %s', (i, s) => expect(X.colName(i)).toBe(s));
});

describe('esc', () => {
  it('экранирует и убирает недопустимые для XML символы', () => {
    expect(X.esc('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
    expect(X.esc('x\u0000\u0007\u000B\u001Fy\t\n\r￾')).toBe('xy\t\n\r');
    expect(X.esc('"кавычки"')).toBe('"кавычки"');
  });
});

describe('zip', () => {
  it('корректная структура, UTF-8 имена, данные читаются обратно', async () => {
    const files = [{ name: 'a.txt', data: enc.encode('hello') }, { name: 'папка/б.xml', data: enc.encode('<x/>') }];
    const z = unzip(await bytes(X.zip(files, 'application/zip')));
    expect(z.map((f) => f.name)).toEqual(['a.txt', 'папка/б.xml']);
    expect(z.map((f) => dec.decode(f.data))).toEqual(['hello', '<x/>']);
    expect(z.every((f) => f.flags === 0x0800)).toBe(true);
    expect(z[1]!.crc).toBe(X.crc32(enc.encode('<x/>')));
  });

  it('детерминирован', async () => {
    const files = [{ name: 'a', data: enc.encode('1') }];
    expect(await bytes(X.zip(files, ''))).toEqual(await bytes(X.zip(files, '')));
  });
});

describe('build', () => {
  const rows: X.Cell[][] = [['№', 'Текст', 'Число'], [1, 'привет <мир> & "всё"', 3.5], [2, null, ''], [3, 'x', NaN]];

  it('нужные части книги и MIME', async () => {
    const blob = X.build(rows, { sheetName: 'OCR' });
    expect(blob.type).toBe(X.XLSX_MIME);
    const names = unzip(await bytes(blob)).map((f) => f.name);
    expect(names).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
  });

  it('ячейки: числа, текст со стилями, пропуск пустых, NaN как текст', () => {
    const sheet = dec.decode(X.buildParts(rows).find((p) => p.name.endsWith('sheet1.xml'))!.data);
    expect(sheet).toContain('<dimension ref="A1:C4"/>');
    expect(sheet).toContain('<autoFilter ref="A1:C4"/>');
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">№</t></is></c>');
    expect(sheet).toContain('<c r="A2"><v>1</v></c>');
    expect(sheet).toContain('<c r="C2"><v>3.5</v></c>');
    expect(sheet).toContain('<c r="B2" s="2" t="inlineStr"><is><t xml:space="preserve">привет &lt;мир&gt; &amp; "всё"</t></is></c>');
    expect(sheet).toContain('<row r="3"><c r="A3"><v>2</v></c></row>');
    expect(sheet).toContain('<c r="C4" s="2" t="inlineStr"><is><t xml:space="preserve">NaN</t></is></c>');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).not.toContain('<cols>');
  });

  it('ширины колонок и длинный текст обрезается', () => {
    const long = 'я'.repeat(40000);
    const sheet = dec.decode(X.buildParts([['a', 'b'], [long, 1]], { widths: [10, 20] }).at(-1)!.data);
    expect(sheet).toContain('<cols><col min="1" max="1" width="10" customWidth="1"/><col min="2" max="2" width="20" customWidth="1"/></cols>');
    expect(sheet).toContain('я'.repeat(X.MAX_CELL) + '</t>');
    expect(sheet).not.toContain('я'.repeat(X.MAX_CELL + 1));
  });

  it('больше 26 колонок — правильные ссылки', () => {
    const header = Array.from({ length: 28 }, (_, i) => 'c' + i);
    const sheet = dec.decode(X.buildParts([header]).at(-1)!.data);
    expect(sheet).toContain('<dimension ref="A1:AB1"/>');
    expect(sheet).toContain('<c r="AB1"');
  });

  it('имя листа: запрещённые символы, длина, пустое', () => {
    const wb = (name: string) => dec.decode(X.buildParts([['x']], { sheetName: name })[2]!.data);
    expect(wb('a/b:c*d?[e]')).toContain('name="a_b_c_d__e_"');
    expect(wb('x'.repeat(40))).toContain(`name="${'x'.repeat(31)}"`);
    expect(wb('')).toContain('name="Sheet1"');
    expect(wb('A&B')).toContain('name="A&amp;B"');
  });

  it('пустая таблица не падает', () => {
    const sheet = dec.decode(X.buildParts([]).at(-1)!.data);
    expect(sheet).toContain('<dimension ref="A1:A0"/>');
  });
});
