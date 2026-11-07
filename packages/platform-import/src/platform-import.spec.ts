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

describe('limit boundaries', () => {
  it('accepts exactly the row limit and refuses the cell past the cell limit by one', () => {
    const atRows = tokeniseCsv('a\n1\n2\n3\n', LIMITS);
    expect(atRows.ok && [atRows.value.rows.length, atRows.value.rowCount]).toEqual([3, 3]);
    const pastRows = tokeniseCsv('a\n1\n2\n3\n4\n', LIMITS);
    expect(pastRows.ok && [pastRows.value.rows.length, pastRows.value.rowCount]).toEqual([3, 4]);
    const atChars = tokeniseCsv(`a\n${'x'.repeat(20)}\n`, LIMITS);
    expect(atChars.ok && atChars.value.rows[0]?.cells[0]).toBe('x'.repeat(20));
    expect(tokeniseCsv(`a\n${'x'.repeat(21)}\n`, LIMITS).ok).toBe(false);
    // A quoted cell is counted by its text, not by its quotes.
    expect(tokeniseCsv(`a\n"${'x'.repeat(20)}"\n`, LIMITS).ok).toBe(true);
  });

  it('accepts exactly the column limit in the header and in a row, and refuses one more', () => {
    expect(tokeniseCsv('a,b,c,d\n1,2,3,4\n', LIMITS).ok).toBe(true);
    expect(tokeniseCsv('a,b,c,d,e\n', LIMITS).ok).toBe(false);
    expect(tokeniseCsv('a\n1,2,3,4\n', LIMITS).ok).toBe(true);
    expect(tokeniseCsv('a\n1,2,3,4,5\n', LIMITS).ok).toBe(false);
  });
});

describe('line endings', () => {
  it('reads bare CR, CRLF and LF as record ends', () => {
    const result = tokeniseCsv('a,b\r1,2\r3,4\r\n5,6\n', LIMITS);
    expect(result.ok && result.value.rows.map((row) => [row.rowNumber, ...row.cells])).toEqual([
      [2, '1', '2'],
      [3, '3', '4'],
      [4, '5', '6'],
    ]);
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
  it.each([
    ['gzip', [0x1f, 0x8b, 0x08]],
    ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]],
    ['JPEG', [0xff, 0xd8, 0xff, 0xe0]],
    ['GIF', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ['ELF', [0x7f, 0x45, 0x4c, 0x46]],
    ['MZ', [0x4d, 0x5a, 0x90]],
    ['legacy Office', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]],
    ['UTF-16 LE BOM', [0xff, 0xfe, 0x61, 0x00]],
    ['UTF-16 BE BOM', [0xfe, 0xff, 0x00, 0x61]],
    ['empty ZIP', [0x50, 0x4b, 0x05, 0x06]],
  ])('refuses %s by its signature', (_name, magic) => {
    expect(looksLikeText(new Uint8Array(magic))).toBe(false);
  });

  it('refuses markup, also behind a UTF-8 byte order mark', () => {
    expect(looksLikeText(bytes('<!doctype html>'))).toBe(false);
    expect(looksLikeText(bytes('<!DOCTYPE html>'))).toBe(false);
    expect(looksLikeText(bytes(`${CSV_BOM}<?xml version="1.0"?>`))).toBe(false);
    expect(looksLikeText(bytes(`${CSV_BOM}<html>`))).toBe(false);
    expect(looksLikeText(bytes(`${CSV_BOM}a,b\n1,2\n`))).toBe(true);
  });

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

  it('writes exact outputs', () => {
    expect(csvCell('=1,2')).toBe('"\'=1,2"');
    expect(csvCell('a=1')).toBe('a=1');
    expect(csvCell('-')).toBe("'-");
    expect(csvCell("'=1")).toBe("''=1");
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('takes off exactly one quote, so genuine text that starts with a quote survives', () => {
    expect(unguardCell("'=1")).toBe('=1');
    expect(unguardCell("''=1")).toBe("'=1");
    expect(unguardCell("'''=1")).toBe("''=1");
    expect(unguardCell("'plain")).toBe("'plain");
    for (const original of ["'=1", "''=1", "'  =1", "'-", '=1']) {
      expect(unguardCell(csvCell(original).replace(/^"|"$/g, ''))).toBe(original);
    }
  });

  it('gives back the original text when a guarded file is read again', () => {
    const originals = ['=SUM(A1)', '-5', '+x', '@home', 'plain', "'plain", "'=1", 'a,b', ''];
    const file = `${csvLine(['c'])}${originals.map((value) => csvLine([value])).join('')}`;
    const parsed = tokeniseCsv(file, { rows: 50, columns: 4, cellChars: 100 });
    expect(parsed.ok && parsed.value.rows.map((row) => unguardCell(row.cells[0]!))).toEqual(
      originals.filter((value) => value !== ''),
    );
  });
});
