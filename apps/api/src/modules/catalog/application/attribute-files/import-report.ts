import { CSV_BOM, csvLine } from '../products/products-csv';
import type { AttributeFileKind } from './file-layout';

/** What happened to one row of an import file. */
export interface ResultRow {
  readonly rowNumber: number;
  readonly key: string;
  readonly result: 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed';
  /** A refusal code, the `column:code` list of a skipped row, or null. */
  readonly code: string | null;
}

export interface ReportFile {
  readonly filename: string;
  readonly contentType: string;
  /** The file, base64. */
  readonly data: string;
}

/**
 * The result report of a run (attributes package A9): one line per row of the file, in file order,
 * as CSV. A cell that starts with = + - @ gets a leading quote (the shared CSV writer). The codes
 * are the editor's own refusal codes, never a text of the file.
 */
export function importReport(
  rows: readonly ResultRow[],
  day: string,
  kind: AttributeFileKind,
): ReportFile {
  const text =
    CSV_BOM +
    [
      csvLine(['row', 'key', 'result', 'detail']),
      ...rows.map((row) => csvLine([row.rowNumber, row.key, row.result, row.code ?? ''])),
    ].join('');
  return {
    filename: `${kind}-import-result-${day}.csv`,
    contentType: 'text/csv; charset=utf-8',
    data: Buffer.from(text, 'utf8').toString('base64'),
  };
}
