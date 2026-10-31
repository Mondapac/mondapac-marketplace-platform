import { IMPORT_LIMITS } from './limits';
import { isZipContainer, looksLikeText, readImportFile } from './import-file';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('readImportFile', () => {
  it('reads a header and rows, row numbers as a spreadsheet shows them', async () => {
    const result = await readImportFile(bytes('Title,Brand\r\nA,B\r\n\r\nC,D\r\n'));
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.header).toEqual(['Title', 'Brand']);
    expect(result.value.rows.map((row) => row.rowNumber)).toEqual([2, 4]);
    expect(result.value.rowCount).toBe(2);
  });

  it('reads quotes, embedded commas and newlines and a byte order mark', async () => {
    const result = await readImportFile(bytes('﻿Title,Description\n"A, b","line1\nline2 ""q"""\n'));
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.header[0]).toBe('Title');
    expect(result.value.rows[0]!.cells).toEqual(['A, b', 'line1\nline2 "q"']);
  });

  it('never evaluates or trims a cell', async () => {
    const result = await readImportFile(bytes('Title\n=1+1\n'));
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.rows[0]!.cells).toEqual(['=1+1']);
  });

  it('refuses an empty file and a header without rows', async () => {
    expect(await readImportFile(new Uint8Array())).toEqual({
      ok: false,
      error: { code: 'file.empty' },
    });
    expect(await readImportFile(bytes('Title,Brand\n'))).toEqual({
      ok: false,
      error: { code: 'file.no-rows' },
    });
  });

  it('refuses a file over the byte limit before reading it', async () => {
    const result = await readImportFile(new Uint8Array(IMPORT_LIMITS.fileBytes + 1));
    expect(result).toEqual({
      ok: false,
      error: { code: 'file.too-large', maxBytes: IMPORT_LIMITS.fileBytes },
    });
  });

  it('refuses more rows than the limit, saying how many', async () => {
    const lines = ['Title'];
    for (let i = 0; i < IMPORT_LIMITS.rows + 1; i += 1) lines.push(`P${i}`);
    const result = await readImportFile(bytes(lines.join('\n')));
    expect(result).toEqual({
      ok: false,
      error: { code: 'file.too-many-rows', rows: IMPORT_LIMITS.rows + 1, max: IMPORT_LIMITS.rows },
    });
  });

  it('accepts exactly the row limit', async () => {
    const lines = ['Title'];
    for (let i = 0; i < IMPORT_LIMITS.rows; i += 1) lines.push(`P${i}`);
    expect((await readImportFile(bytes(lines.join('\n')))).ok).toBe(true);
  });

  it('refuses a cell over the character limit, naming the row', async () => {
    const long = 'x'.repeat(IMPORT_LIMITS.cellChars + 1);
    const result = await readImportFile(bytes(`Title\nok\n${long}\n`));
    expect(result).toEqual({
      ok: false,
      error: { code: 'file.cell-too-long', rowNumber: 3, max: IMPORT_LIMITS.cellChars },
    });
  });

  it('refuses too many columns', async () => {
    const header = Array.from({ length: IMPORT_LIMITS.columns + 1 }, (_, i) => `c${i}`).join(',');
    const result = await readImportFile(bytes(`${header}\n1\n`));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('file.too-many-columns');
  });

  it('refuses a data row with too many cells, and stops reading it at the limit', async () => {
    const wide = ','.repeat(IMPORT_LIMITS.columns + 5);
    expect(await readImportFile(bytes(`Title\nok\n${wide}\n`))).toEqual({
      ok: false,
      error: { code: 'file.too-many-columns', max: IMPORT_LIMITS.columns },
    });
    // A row of exactly the limit is still read (and cut to the header's width).
    const atLimit = ','.repeat(IMPORT_LIMITS.columns - 1);
    expect((await readImportFile(bytes(`Title\nok${atLimit}\n`))).ok).toBe(true);
    // A 5 MB line of commas is refused at the limit, not after building millions of cells.
    const started = Date.now();
    const huge = await readImportFile(bytes(`Title\n${','.repeat(5_000_000)}\n`));
    expect(huge.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reads the type from the content, never the name: a ZIP is an unsupported XLSX', async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(isZipContainer(zip)).toBe(true);
    expect(await readImportFile(zip)).toEqual({
      ok: false,
      error: { code: 'file.unsupported-type', detected: 'xlsx' },
    });
  });

  it('refuses binary content as another type', async () => {
    for (const head of [
      [0x25, 0x50, 0x44, 0x46, 0x2d],
      [0x89, 0x50, 0x4e, 0x47],
      [0x1f, 0x8b, 8],
    ]) {
      const file = new Uint8Array([...head, 0, 1, 2, 3]);
      expect(looksLikeText(file)).toBe(false);
      expect(await readImportFile(file)).toEqual({
        ok: false,
        error: { code: 'file.unsupported-type', detected: 'other' },
      });
    }
  });

  it('uses a pluggable parser when one matches', async () => {
    const table = {
      format: 'xlsx' as const,
      header: ['a'],
      rows: [{ rowNumber: 2, cells: ['1'] }],
      rowCount: 1,
    };
    const result = await readImportFile(new Uint8Array([1, 2, 3]), IMPORT_LIMITS, [
      { format: 'xlsx', sniff: () => true, parse: () => ({ ok: true, value: table }) },
    ]);
    expect(result).toEqual({ ok: true, value: table });
  });
});
