import { csvLine, CSV_BOM } from '../products/products-csv';
import { IMPORT_COLUMNS, type ImportColumnKey } from '../../domain/platform-import/columns';
import type { ImportJob, ImportRowRecord } from '../../domain/platform-import/platform-import-job';
import type { RowIssue } from '../../domain/platform-import/row-check';

// The two reports of a platform import (catalog design 14a): the error report of the check and the
// full report of a run. English text, because a file is data, not a page. Every cell goes through
// the export's `csvCell`, which writes a leading quote before a cell that starts with = + - @ tab
// or carriage return, so a spreadsheet never runs a value from the uploaded file as a formula
// (design 14, AC 41; the values are the admin's own file, but a file is passed around).

const HEADER_OF = new Map<ImportColumnKey | 'row', string>([
  ...IMPORT_COLUMNS.map((column) => [column.key, column.header] as const),
  ['row', 'Row'],
]);

/** The column's header as the template shows it. */
export function headerOf(column: ImportColumnKey | 'row'): string {
  return HEADER_OF.get(column) ?? 'Row';
}

/** The reason of a row's issue or failed run, in words (the page has its own copy for the same codes). */
export function problemText(
  code: string,
  column: ImportColumnKey | 'row',
  otherRow?: number,
): string {
  const header = headerOf(column);
  switch (code) {
    case 'required':
      return `${header} is required`;
    case 'too-long':
      return `${header} is too long`;
    case 'category.unknown':
      return 'No category with this name';
    case 'category.ambiguous':
      return 'More than one category has this name';
    case 'product-type.unknown':
      return 'No product type with this name';
    case 'product-type.needs-variants':
      return 'Products with variants can’t be imported from a file yet';
    case 'gtin.length':
      return 'Not a valid barcode length';
    case 'gtin.check-digit':
      return 'Not a valid barcode: the check digit is wrong';
    case 'image-url.not-https':
      return 'Use an https link';
    case 'image-url.not-fetched':
      return 'Image links are not fetched: add the photo on the product';
    case 'column.not-stored':
      return 'Checked, not stored: this catalog has no attribute for it';
    case 'tax-category.unknown':
      return 'No tax category with this code';
    case 'tax-category.default-used':
      return 'No tax category given: the Market default is used';
    case 'duplicate-in-file':
      return otherRow === undefined
        ? 'Same title and brand as another row'
        : `Same title and brand as row ${otherRow}`;
    case 'text.invalid-characters':
      return 'Contains a character that can’t be stored';
    case 'attribute.required':
      return `${header} is required for this catalog`;
    case 'attribute.too-long':
    case 'attribute.type':
    case 'attribute.out-of-range':
    case 'text.invisible-character':
      return `${header} is not valid`;
    // Run reasons.
    case 'claim-text.found':
      return 'The text mentions a certification. Certification belongs to a seller’s offer, not to the product';
    case 'claim-text.check-unavailable':
      return 'The certification-wording check was unavailable';
    case 'revision.not-ready':
      return 'The product did not pass the catalog checks';
    case 'row.changed':
      return 'The row no longer passes the check';
    case 'product.type-not-offered':
      return 'This product type is no longer offered';
    case 'access.denied':
      return 'You no longer have access to add this product';
    default:
      return 'The product could not be added';
  }
}

/** The lines of one issue list that are errors. */
function errorIssues(row: ImportRowRecord): readonly RowIssue[] {
  return row.issues.filter((issue) => issue.severity === 'error');
}

/** The check's error report: one line per problem of a row with errors (row, column, value, problem). */
export function errorReportCsv(rows: readonly ImportRowRecord[]): string {
  let out = CSV_BOM + csvLine(['Row', 'Column', 'Value in the file', 'Problem']);
  for (const row of rows) {
    if (row.checkState !== 'error') continue;
    for (const issue of errorIssues(row)) {
      out += csvLine([
        row.rowNumber,
        headerOf(issue.column),
        issue.value,
        problemText(issue.code, issue.column, issue.otherRow),
      ]);
    }
  }
  return out;
}

/** What happened to a row, for the full report. */
export function resultOf(job: Pick<ImportJob, 'state'>, row: ImportRowRecord): string {
  if (row.runState === 'added') return 'Added';
  if (row.runState === 'failed') return 'Not imported';
  if (row.runState === 'skipped' || row.checkState === 'error') return 'Skipped at check';
  return job.state === 'stopped' ? 'Not tried' : 'Pending';
}

/** The full report of a run: every row, what happened to it and why. */
export function fullReportCsv(
  job: Pick<ImportJob, 'state'>,
  rows: readonly ImportRowRecord[],
): string {
  let out = CSV_BOM + csvLine(['Row', 'Title', 'Result', 'Product code', 'Details']);
  for (const row of rows) {
    const details: string[] = [];
    if (row.runState === 'failed' && row.runCode !== null) {
      details.push(problemText(row.runCode, 'row'));
    }
    for (const issue of row.issues) {
      details.push(
        `${headerOf(issue.column)}: ${problemText(issue.code, issue.column, issue.otherRow)}`,
      );
    }
    out += csvLine([
      row.rowNumber,
      row.summary.title,
      resultOf(job, row),
      row.productCode,
      details.join('; '),
    ]);
  }
  return out;
}

/** The template file: a header row and one example row. */
export function templateCsv(rows: readonly (readonly string[])[]): string {
  return CSV_BOM + rows.map((cells) => csvLine(cells)).join('');
}
