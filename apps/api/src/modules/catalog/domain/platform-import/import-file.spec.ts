import { IMPORT_LIMITS } from './limits';
import { isZipContainer, looksLikeText, readImportFile } from './import-file';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('readImportFile', () => {
  it('reads a header and rows, row numbers as a spreadsheet shows them', () => {
    const result = readImportFile(bytes('Title,Brand\r\nA,B\r\n\r\nC,D\r\n'));
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.header).toEqual(['Title', 'Brand']);
    expect(result.value.rows.map((row) => row.rowNumber)).toEqual([2, 4]);
    expect(result.value.rowCount).toBe(2);
  });

  it('reads quotes, embedded commas and newlines and a byte order mark', () => {
    const result = readImportFile(bytes('﻿Title,Description\n"A, b","line1\nline2 ""q"""\n'));
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.header[0]).toBe('Title');
    expect(result.value.rows[0]!.cells).toEqual(['A, b', 'line1\nline2 "q"']);
  });

  it('never evaluates or trims a cell', () => {
    const result = readImportFile(bytes('Title\n=1+1\n'));
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.rows[0]!.cells).toEqual(['=1+1']);
  });

  it('refuses an empty file and a header without rows', () => {
    expect(readImportFile(new Uint8Array())).toEqual({ ok: false, error: { code: 'file.empty' } });
    expect(readImportFile(bytes('Title,Brand\n'))).toEqual({
      ok: false,
      error: { code: 'file.no-rows' },
    });
  });

  it('refuses a file over the byte limit before reading it', () => {
    const result = readImportFile(new Uint8Array(IMPORT_LIMITS.fileBytes + 1));
    expect(result).toEqual({
      ok: false,
      error: { code: 'file.too-large', maxBytes: IMPORT_LIMITS.fileBytes },
    });
  });

  it('refuses more rows than the limit, saying how many', () => {
    const lines = ['Title'];
    for (let i = 0; i < IMPORT_LIMITS.rows + 1; i += 1) lines.push(`P${i}`);
    const result = readImportFile(bytes(lines.join('\n')));
    expect(result).toEqual({
      ok: false,
      error: { code: 'file.too-many-rows', rows: IMPORT_LIMITS.rows + 1, max: IMPORT_LIMITS.rows },
    });
  });

  it('accepts exactly the row limit', () => {
    const lines = ['Title'];
    for (let i = 0; i < IMPORT_LIMITS.rows; i += 1) lines.push(`P${i}`);
    expect(readImportFile(bytes(lines.join('\n'))).ok).toBe(true);
  });

  it('refuses a cell over the character limit, naming the row', () => {
    const long = 'x'.repeat(IMPORT_LIMITS.cellChars + 1);
    const result = readImportFile(bytes(`Title\nok\n${long}\n`));
    expect(result).toEqual({
      ok: false,
      error: { code: 'file.cell-too-long', rowNumber: 3, max: IMPORT_LIMITS.cellChars },
    });
  });

  it('refuses too many columns', () => {
    const header = Array.from({ length: IMPORT_LIMITS.columns + 1 }, (_, i) => `c${i}`).join(',');
    const result = readImportFile(bytes(`${header}\n1\n`));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('file.too-many-columns');
  });

  it('reads the type from the content, never the name: a ZIP is an unsupported XLSX', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(isZipContainer(zip)).toBe(true);
    expect(readImportFile(zip)).toEqual({
      ok: false,
      error: { code: 'file.unsupported-type', detected: 'xlsx' },
    });
  });

  it('refuses binary content as another type', () => {
    for (const head of [
      [0x25, 0x50, 0x44, 0x46, 0x2d],
      [0x89, 0x50, 0x4e, 0x47],
      [0x1f, 0x8b, 8],
    ]) {
      const file = new Uint8Array([...head, 0, 1, 2, 3]);
      expect(looksLikeText(file)).toBe(false);
      expect(readImportFile(file)).toEqual({
        ok: false,
        error: { code: 'file.unsupported-type', detected: 'other' },
      });
    }
  });

  it('uses a pluggable parser when one matches', () => {
    const table = { header: ['a'], rows: [{ rowNumber: 2, cells: ['1'] }], rowCount: 1 };
    const result = readImportFile(new Uint8Array([1, 2, 3]), IMPORT_LIMITS, [
      { format: 'xlsx', sniff: () => true, parse: () => ({ ok: true, value: table }) },
    ]);
    expect(result).toEqual({ ok: true, value: table });
  });
});
