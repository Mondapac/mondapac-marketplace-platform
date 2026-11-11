// The category tree import page (categories package C7b): the answers of the C7a routes, and the
// small rules the page keeps about them. A row's slug is a valid slug or empty (the API never
// echoes a cell); text of the file is never shown.

import type { ApiFailure } from '../../api/client.ts';

export const IMPORT_PERMISSION = 'catalog.category-tree.import';
export const IMPORT_PAGE_PATH = '/catalog/categories/import';
export const API_IMPORT = 'catalog/admin/category-tree/import';
export const API_EXPORT = 'catalog/admin/category-tree/export';

export type RowAction = 'create' | 'update' | 'unchanged' | 'error';

export interface RowIssue {
  readonly path: string;
  readonly code: string;
}

export interface RowResult {
  readonly rowNumber: number;
  readonly slug: string;
  readonly action: RowAction;
  readonly code: string | null;
  readonly issues: readonly RowIssue[];
}

export interface ImportCounts {
  readonly create: number;
  readonly update: number;
  readonly unchanged: number;
  readonly error: number;
}

export interface DryRunBody {
  readonly fileSha256: string;
  readonly treeVersion: number;
  readonly format: 'csv' | 'xlsx';
  readonly counts: ImportCounts;
  readonly clean: boolean;
  readonly rows: readonly RowResult[];
}

export interface ApplyBody {
  readonly treeVersion: number;
  readonly counts: ImportCounts;
  readonly written: boolean;
}

export type RowFilter = 'all' | 'errors';

/** The rows to show: all of them, or only the ones with an error. */
export function visibleRows(rows: readonly RowResult[], filter: RowFilter): readonly RowResult[] {
  return filter === 'errors' ? rows.filter((row) => row.action === 'error') : rows;
}

/** A file is applied only when no row is an error and at least one row writes. */
export function canApply(body: DryRunBody): boolean {
  return body.counts.error === 0 && body.counts.create + body.counts.update > 0;
}

/** The byte order mark that makes a spreadsheet read the file as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** A spreadsheet reads a cell that starts like this as a formula. */
const FORMULA_START = /^\s*[=+\-@\t\r＝＋－＠]/u;

function cell(value: string | number): string {
  const text = String(value);
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * The error report of a check, one line per problem: the row number a spreadsheet shows, the
 * category's slug, the column and the code. It holds codes only, never a cell of the file.
 */
export function errorReportCsv(rows: readonly RowResult[]): string {
  const lines: (string | number)[][] = [['row', 'slug', 'column', 'code']];
  for (const row of rows) {
    if (row.action !== 'error') continue;
    const issues =
      row.issues.length > 0 ? row.issues : [{ path: '', code: row.code ?? 'row.invalid' }];
    for (const issue of issues) lines.push([row.rowNumber, row.slug, issue.path, issue.code]);
  }
  return `${BOM}${lines.map((line) => line.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** The page's own words for a refusal of the file or of the apply. */
export type ImportProblem =
  | { readonly kind: 'stale' }
  | { readonly kind: 'file-changed' }
  | { readonly kind: 'has-errors' }
  | { readonly kind: 'columns'; readonly fields: readonly RowIssue[] }
  | { readonly kind: 'file'; readonly code: string; readonly maxBytes: number | null }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'claim-check' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'unknown' };

const FILE_CODES = new Set([
  'file.too-large',
  'file.unpacked-too-large',
  'file.unsupported-type',
  'file.empty',
  'file.unreadable',
  'file.too-many-columns',
  'file.cell-too-long',
  'file.too-many-rows',
  'file.no-rows',
  'file.formula-cell',
  'file.too-complex',
  'validation.failed',
]);

export function problemOf(failure: ApiFailure): ImportProblem {
  if (failure.status === 403) return { kind: 'forbidden' };
  switch (failure.code) {
    case 'conflict.stale':
      return { kind: 'stale' };
    case 'import.file-changed':
      return { kind: 'file-changed' };
    case 'import.has-errors':
      return { kind: 'has-errors' };
    case 'import.columns-invalid':
      return { kind: 'columns', fields: failure.details?.fields ?? [] };
    case 'claim-text.check-unavailable':
      return { kind: 'claim-check' };
    case 'file.busy':
    case 'access.unavailable':
      return { kind: 'busy' };
    default:
      return FILE_CODES.has(failure.code)
        ? { kind: 'file', code: failure.code, maxBytes: failure.details?.maxBytes ?? null }
        : { kind: 'unknown' };
  }
}

/** The file as base64 text, read in the browser; null when it cannot be read. */
export function readAsBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const comma = text.indexOf(',');
      resolve(comma < 0 ? null : text.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}
