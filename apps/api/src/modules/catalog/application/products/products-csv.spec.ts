import { CSV_BOM, csvCell, csvLine, EXPORT_COLUMNS, EXPORT_HEADERS } from './products-csv';

describe('the CSV of the admin product export (catalog design 9.2c)', () => {
  describe('csvCell', () => {
    it.each([
      '=SUM(A1:A9)',
      '+1+1',
      '-2+3',
      '@cmd',
      '\tTab',
      '\rReturn',
      ' =HYPERLINK(1)',
      '  +1',
      '\u00a0@cmd',
      '\uFF1DSUM(A1)',
      '\uFF0B1',
      '\uFF0D2',
      '\uFF20cmd',
      ' \uFF1DSUM(A1)',
    ])('prefixes %j with a quote, so a spreadsheet never runs it as a formula', (value) => {
      const cell = csvCell(value);

      // The leading quote (inside the field quotes where a line break needs them).
      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
      expect(cell).toContain(value.replace(/"/g, '""'));
    });

    it('guards the formula that hides behind a quoted comma', () => {
      expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    });

    it('leaves a plain text, an inner sign and a number as they are', () => {
      expect(csvCell('Dates')).toBe('Dates');
      expect(csvCell('Dates = good')).toBe('Dates = good');
      expect(csvCell('a-b')).toBe('a-b');
      expect(csvCell(12)).toBe('12');
      expect(csvCell(0)).toBe('0');
      expect(csvCell(null)).toBe('');
    });

    it('quotes a comma, a quote and a line break (RFC 4180)', () => {
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell('one\ntwo')).toBe('"one\ntwo"');
    });
  });

  it('ends a line in CRLF and joins the cells with commas', () => {
    expect(csvLine(['a', 'b,c', 3, null])).toBe('a,"b,c",3,\r\n');
  });

  it('starts the file with the byte order mark', () => {
    expect(CSV_BOM).toBe('﻿');
  });

  it('names a header for every optional column', () => {
    for (const column of EXPORT_COLUMNS) expect(EXPORT_HEADERS[column]).toEqual(expect.any(String));
  });
});
