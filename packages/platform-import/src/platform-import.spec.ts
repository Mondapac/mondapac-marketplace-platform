import { describe, expect, it } from 'vitest';
import {
  CSV_BOM,
  csvCell,
  csvLine,
  looksLikeText,
  parseCsvBytes,
  startsLikeFormula,
  tokeniseCsv,
  unguardCell,
} from './index';

const LIMITS = { rows: 3, columns: 4, cellChars: 20 };
const bytes = (text: string) => new TextEncoder().encode(text);

describe('tokeniseCsv', () => {
  it('reads a header and rows with spreadsheet row numbers, padded to the header', () => {
    const result = tokeniseCsv('a,b,c\r\n1,2\r\n"x,y",""\r\n', LIMITS);
    expect(result).toEqual({
      ok: true,
      value: {
        header: ['a', 'b', 'c'],
        rows: [
          { rowNumber: 2, cells: ['1', '2', ''] },
          { rowNumber: 3, cells: ['x,y', '', ''] },
        ],
        rowCount: 2,
      },
    });
  });

  it('never trims a cell and keeps a quoted quote', () => {
    const result = tokeniseCsv('a\n" x ""y"" "\n', LIMITS);
    expect(result.ok && result.value.rows[0]?.cells).toEqual([' x "y" ']);
  });

  it('counts rows past the limit without keeping them', () => {
    const result = tokeniseCsv('a\n1\n2\n3\n4\n5\n', LIMITS);
    expect(result.ok && [result.value.rows.length, result.value.rowCount]).toEqual([3, 5]);
  });

  it('refuses too many columns in the header and in a data row', () => {
    expect(tokeniseCsv('a,b,c,d,e\n', LIMITS)).toEqual({
      ok: false,
      error: { code: 'file.too-many-columns', max: 4 },
    });
    expect(tokeniseCsv('a\n1,2,3,4,5\n', LIMITS)).toEqual({
      ok: false,
      error: { code: 'file.too-many-columns', max: 4 },
    });
  });

  it('refuses a cell over the limit with its row number', () => {
    expect(tokeniseCsv(`a\n${'x'.repeat(21)}\n`, LIMITS)).toEqual({
      ok: false,
      error: { code: 'file.cell-too-long', rowNumber: 2, max: 20 },
    });
  });

  it('refuses an unterminated quote', () => {
    expect(tokeniseCsv('a\n"open', LIMITS)).toEqual({
      ok: false,
      error: { code: 'file.unreadable' },
    });
  });

  it('skips blank lines but keeps a quoted empty cell as a row', () => {
    const result = tokeniseCsv('a\n\n""\n', LIMITS);
    expect(result.ok && result.value.rowCount).toBe(1);
  });
});

describe('parseCsvBytes', () => {
  it('accepts a byte order mark and refuses bytes that are not UTF-8', () => {
    const ok = parseCsvBytes(bytes(`${CSV_BOM}a\n1\n`), LIMITS);
    expect(ok.ok && ok.value.header).toEqual(['a']);
    expect(parseCsvBytes(new Uint8Array([0x61, 0xff, 0xfe, 0x0a]), LIMITS)).toEqual({
      ok: false,
      error: { code: 'file.unreadable' },
    });
  });
});

describe('looksLikeText', () => {
  it('refuses a ZIP, a PDF, a NUL byte and markup', () => {
    expect(looksLikeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
    expect(looksLikeText(bytes('%PDF-1.7'))).toBe(false);
    expect(looksLikeText(new Uint8Array([0x61, 0x00, 0x62]))).toBe(false);
    expect(looksLikeText(bytes('  <?xml version="1.0"?>'))).toBe(false);
    expect(looksLikeText(bytes('<HTML>'))).toBe(false);
    expect(looksLikeText(bytes('a,b\n1,2\n'))).toBe(true);
  });
});

describe('formula guard', () => {
  it.each(['=1+1', '+1', '-1', '@x', '\tx', '\rx', '  =1', '＝1', '＋1', '－1', '＠x'])(
    'quotes %j',
    (value) => {
      expect(startsLikeFormula(value)).toBe(true);
      expect(csvCell(value).replace(/^"/, '').startsWith("'")).toBe(true);
    },
  );

  it('leaves plain text, numbers and nothing alone and quotes commas, quotes and breaks', () => {
    expect(csvCell('Large')).toBe('Large');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(null)).toBe('');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvLine(['a', 1, null])).toBe('a,1,\r\n');
  });

  it('gives back the original text when a guarded file is read again', () => {
    const originals = ['=SUM(A1)', '-5', '+x', '@home', 'plain', "'plain", 'a,b', ''];
    const file = `${csvLine(['c'])}${originals.map((value) => csvLine([value])).join('')}`;
    const parsed = tokeniseCsv(file, { rows: 50, columns: 4, cellChars: 100 });
    expect(parsed.ok && parsed.value.rows.map((row) => unguardCell(row.cells[0]!))).toEqual(
      originals.filter((value) => value !== ''),
    );
  });
});
