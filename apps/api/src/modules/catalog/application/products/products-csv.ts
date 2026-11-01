// The CSV of the admin product export (catalog design 9.2c): pure text functions, no I/O.

/** The optional columns of the list, as the page's column picker names them. */
export const EXPORT_COLUMNS = [
  'code',
  'offers',
  'updated',
  'type',
  'scope',
  'seller',
  'created',
] as const;
export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

/** The header of each column (English; the file is data, not a page). */
export const EXPORT_HEADERS: Readonly<
  Record<ExportColumn | 'name' | 'category' | 'status', string>
> = Object.freeze({
  name: 'Product',
  code: 'Product code',
  category: 'Category',
  status: 'Status',
  offers: 'Offers',
  updated: 'Last changed',
  type: 'Product type',
  scope: 'Scope',
  seller: 'Seller',
  created: 'Created',
});

/**
 * Spreadsheets run a cell that starts with one of these as a formula (CSV injection, OWASP). The
 * test looks past leading whitespace (some locales and import settings trim it) and covers the
 * fullwidth signs `＝ ＋ － ＠` (U+FF1D, U+FF0B, U+FF0D, U+FF20) that a spreadsheet may fold.
 */
const FORMULA_START = /^\s*[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/u;

/**
 * One cell as text: a text that a spreadsheet would read as a formula gets a leading quote (`'`),
 * which every common spreadsheet shows as plain text; then RFC 4180 quoting for a comma, a quote
 * or a line break. A number is written as it is (never negative here), so it is never altered.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One line of cells, ending in CRLF. */
export function csvLine(cells: readonly (string | number | null)[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** The byte order mark that makes a spreadsheet read the file as UTF-8. */
export const CSV_BOM = '﻿';
