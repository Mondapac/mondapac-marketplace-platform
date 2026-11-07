// The formula guard of a CSV cell (catalog design 14, AC 41): one copy for the server's exports
// and reports and for the files the panels write.

/**
 * Spreadsheets run a cell that starts with one of these as a formula (CSV injection, OWASP). The
 * test looks past leading whitespace (some locales and import settings trim it) and covers the
 * fullwidth signs `＝ ＋ － ＠` (U+FF1D, U+FF0B, U+FF0D, U+FF20) that a spreadsheet may fold.
 */
const FORMULA_START = /^\s*[=+\-@\t\r＝＋－＠]/u;

/** True when a spreadsheet would read the text as a formula. */
export function startsLikeFormula(value: string): boolean {
  return FORMULA_START.test(value);
}

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
export const CSV_BOM = '\uFEFF';

/**
 * The cell as its writer meant it: a leading quote that the guard added is taken off, so a file
 * written with the guard and read back gives the original text (the round trip of 14b). Only a
 * quote the guard would have added is removed: `'plain` stays `'plain`.
 */
export function unguardCell(value: string): string {
  return value.startsWith("'") && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;
}
