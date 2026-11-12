import { describe, expect, it } from 'vitest';
import {
  canApply,
  errorReportCsv,
  problemOf,
  visibleRows,
  type DryRunBody,
  type RowResult,
} from './import-model.ts';

const row = (
  rowNumber: number,
  action: RowResult['action'],
  over: Partial<RowResult> = {},
): RowResult => ({
  rowNumber,
  slug: `c-${rowNumber}`,
  action,
  code: action === 'error' ? 'slug.taken' : null,
  issues: action === 'error' ? [{ path: 'slug', code: 'slug.taken' }] : [],
  ...over,
});
const body = (counts: Partial<DryRunBody['counts']>, rows: RowResult[] = []): DryRunBody => ({
  fileSha256: 'a'.repeat(64),
  treeVersion: 3,
  format: 'csv',
  counts: { create: 0, update: 0, unchanged: 0, error: 0, ...counts },
  clean: false,
  rows,
});

describe('canApply', () => {
  it('needs no error row and at least one row that writes', () => {
    expect(canApply(body({ create: 1 }))).toBe(true);
    expect(canApply(body({ update: 2, unchanged: 5 }))).toBe(true);
    expect(canApply(body({ create: 1, error: 1 }))).toBe(false);
    expect(canApply(body({ unchanged: 3 }))).toBe(false);
    expect(canApply(body({}))).toBe(false);
  });
});

describe('visibleRows', () => {
  it('shows every row, or only the rows with an error', () => {
    const rows = [row(2, 'create'), row(3, 'error'), row(4, 'unchanged')];
    expect(visibleRows(rows, 'all')).toHaveLength(3);
    expect(visibleRows(rows, 'errors').map((r) => r.rowNumber)).toEqual([3]);
  });
});

describe('errorReportCsv', () => {
  it('writes one line per problem with codes only, behind a byte order mark', () => {
    const rows = [
      row(2, 'create'),
      row(3, 'error', {
        issues: [
          { path: 'slug', code: 'slug.taken' },
          { path: 'texts.en.name', code: 'required' },
        ],
      }),
      row(5, 'error', { slug: '', issues: [] }),
    ];
    expect(errorReportCsv(rows)).toBe(
      '﻿row,slug,column,code\r\n3,c-3,slug,slug.taken\r\n3,c-3,texts.en.name,required\r\n5,,,slug.taken\r\n',
    );
  });

  it('quotes a cell that a spreadsheet would run as a formula', () => {
    const rows = [row(2, 'error', { slug: '=1+1', issues: [{ path: '@x', code: 'a,b' }] })];
    expect(errorReportCsv(rows)).toBe('﻿row,slug,column,code\r\n2,\'=1+1,\'@x,"a,b"\r\n');
  });
});

describe('problemOf', () => {
  it('names the refusals the page words itself', () => {
    expect(problemOf({ status: 409, code: 'conflict.stale' })).toEqual({ kind: 'stale' });
    expect(problemOf({ status: 409, code: 'import.file-changed' })).toEqual({
      kind: 'file-changed',
    });
    expect(problemOf({ status: 409, code: 'import.has-errors' })).toEqual({ kind: 'has-errors' });
    expect(problemOf({ status: 403, code: 'forbidden' })).toEqual({ kind: 'forbidden' });
    expect(problemOf({ status: 503, code: 'claim-text.check-unavailable' })).toEqual({
      kind: 'claim-check',
    });
    expect(problemOf({ status: 503, code: 'file.busy' })).toEqual({ kind: 'busy' });
    expect(
      problemOf({ status: 413, code: 'file.too-large', details: { maxBytes: 5_242_880 } }),
    ).toEqual({ kind: 'file', code: 'file.too-large', maxBytes: 5_242_880 });
    expect(
      problemOf({
        status: 422,
        code: 'import.columns-invalid',
        details: { fields: [{ path: 'columns.slug', code: 'column.missing' }] },
      }),
    ).toEqual({ kind: 'columns', fields: [{ path: 'columns.slug', code: 'column.missing' }] });
    expect(problemOf({ status: 500, code: 'internal' })).toEqual({ kind: 'unknown' });
    expect(problemOf({ status: 0, code: 'network' })).toEqual({ kind: 'unknown' });
  });
});
