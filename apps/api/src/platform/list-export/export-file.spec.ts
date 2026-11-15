import { ExceljsSheetWriter } from './exceljs-sheet-writer';
import {
  buildExportFile,
  checkExportSize,
  LIST_EXPORT_MAX_ROWS,
  parseExportColumns,
  parseExportFormat,
  parseExportIds,
} from './export-file';

function groups(): AsyncIterable<readonly (readonly (string | number | null)[])[]> {
  return (async function* () {
    await Promise.resolve();
    yield [['Name', 'Count']];
    yield [
      ['=SUM(A1)', 3],
      ['Plain', null],
    ];
  })();
}

async function read(chunks: AsyncIterable<string | Uint8Array>): Promise<string> {
  let out = '';
  for await (const chunk of chunks) out += typeof chunk === 'string' ? chunk : '';
  return out;
}

describe('the shared list export', () => {
  it('reads the format: CSV by default, XLSX on request, anything else refused', () => {
    expect(parseExportFormat(undefined)).toEqual({ ok: true, value: 'csv' });
    expect(parseExportFormat('xlsx')).toEqual({ ok: true, value: 'xlsx' });
    expect(parseExportFormat('pdf')).toMatchObject({ ok: false });
  });

  it('reads the chosen columns in order, once each, and refuses an unknown one', () => {
    expect(parseExportColumns('b,a,b', ['a', 'b', 'c'])).toEqual({ ok: true, value: ['b', 'a'] });
    expect(parseExportColumns(undefined, ['a'])).toEqual({ ok: true, value: [] });
    expect(parseExportColumns('z', ['a'])).toMatchObject({ ok: false });
    expect(parseExportColumns(5, ['a'])).toMatchObject({ ok: false });
  });

  it('reads the selected ids: bounded, well-formed, no repeat', () => {
    const toId = (part: string): string | null => (/^[a-z]$/.test(part) ? part : null);
    expect(parseExportIds('a,b', 3, toId)).toEqual({ ok: true, value: ['a', 'b'] });
    expect(parseExportIds('a,b,c,d', 3, toId)).toMatchObject({
      ok: false,
      error: { code: 'batch.too-large', max: 3 },
    });
    expect(parseExportIds('a,1', 3, toId)).toMatchObject({ ok: false });
    expect(parseExportIds('a,a', 3, toId)).toMatchObject({ ok: false });
  });

  it('refuses more than the cap whole, with the total when it is known', () => {
    expect(checkExportSize(LIST_EXPORT_MAX_ROWS)).toEqual({ ok: true, value: true });
    expect(checkExportSize(LIST_EXPORT_MAX_ROWS + 1, 12_345)).toEqual({
      ok: false,
      error: { code: 'batch.too-large', max: LIST_EXPORT_MAX_ROWS, total: 12_345 },
    });
  });

  it('writes a CSV with a byte order mark and a quote before a formula', async () => {
    const file = buildExportFile({
      format: 'csv',
      baseName: 'things',
      sheetName: 'Things',
      day: '2026-11-15',
      groups: groups(),
      sheetWriter: new ExceljsSheetWriter(),
    });
    expect(file.filename).toBe('things-2026-11-15.csv');
    expect(file.contentType).toBe('text/csv; charset=utf-8');
    const text = await read(file.chunks);
    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain("'=SUM(A1)");
  });

  it('writes an XLSX as bytes', async () => {
    const file = buildExportFile({
      format: 'xlsx',
      baseName: 'things',
      sheetName: 'Things',
      day: '2026-11-15',
      groups: groups(),
      sheetWriter: new ExceljsSheetWriter(),
    });
    expect(file.filename).toBe('things-2026-11-15.xlsx');
    let bytes = 0;
    for await (const chunk of file.chunks) bytes += (chunk as Uint8Array).length;
    expect(bytes).toBeGreaterThan(100);
  });
});
