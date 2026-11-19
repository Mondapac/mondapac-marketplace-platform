import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { isZipContainer, looksLikeText, parseCsvBytes } from '@mondapac/platform-import';
import { IMPORT_LIMITS, type ImportLimits } from './limits';

export { isZipContainer, looksLikeText };

/** The formats a parser may read. `csv` is parsed in the domain; `xlsx` by the infrastructure parser (exceljs). */
export const IMPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** One data row. `rowNumber` is the number a spreadsheet shows: the header is row 1. */
export interface ParsedRow {
  readonly rowNumber: number;
  /** One text per header column, padded with empty strings. Never evaluated, never trimmed here. */
  readonly cells: readonly string[];
}

export interface ParsedTable {
  /** The format the table was read from (the job records it). */
  readonly format: ImportFormat;
  readonly header: readonly string[];
  readonly rows: readonly ParsedRow[];
  /** Every non-blank data row of the file, also those past the row limit. */
  readonly rowCount: number;
  /**
   * The table as CSV bytes, when the parser had to open a container to read it. The check stores
   * these instead of the upload, so later reads (the worker's turns) parse plain text and never
   * open the container again (Hassan M-586-1). Absent for a CSV, which is stored as it came.
   */
  readonly canonical?: Uint8Array;
}

/** Why a file was refused before any row was looked at. Codes and numbers only, never a value. */
export type FileRefusal =
  | { readonly code: 'file.empty' }
  | { readonly code: 'file.too-large'; readonly maxBytes: number }
  /** A container that would unpack past the limit, or by a suspicious ratio (zip bomb guard). */
  | { readonly code: 'file.unpacked-too-large'; readonly maxBytes: number }
  | { readonly code: 'file.unsupported-type'; readonly detected: ImportFormat | 'other' }
  | { readonly code: 'file.unreadable' }
  | { readonly code: 'file.too-many-columns'; readonly max: number }
  | { readonly code: 'file.cell-too-long'; readonly rowNumber: number; readonly max: number }
  | { readonly code: 'file.too-many-rows'; readonly rows: number; readonly max: number }
  /** A spreadsheet cell that holds a formula: formulas are refused, never read or evaluated. */
  | { readonly code: 'file.formula-cell'; readonly rowNumber: number }
  | { readonly code: 'file.no-rows' }
  /**
   * A workbook the parse could not finish within its time or its strings' run limit (Hassan
   * M-586-8): nothing is wrong with the bytes, the file asks for more work than one import may take.
   */
  | { readonly code: 'file.too-complex' }
  /** Another XLSX is being read in this process right now; the same upload will go through shortly. */
  | { readonly code: 'file.busy'; readonly retryAfterSeconds: number };

/**
 * The seam for a file format (design 14a: pluggable). A parser answers whether the bytes are its
 * format from their content alone (never from the file name or the declared type) and reads them
 * into a table within the limits. The XLSX parser (infrastructure, exceljs) joins the list the
 * use cases are given; nothing else changes: the checks read a {@link ParsedTable}. A parser may
 * be asynchronous.
 */
export interface ImportFileParser {
  readonly format: ImportFormat;
  /** True when the first bytes look like this format. A cheap look, no decode. */
  sniff(bytes: Uint8Array): boolean;
  parse(
    bytes: Uint8Array,
    limits: ImportLimits,
  ): Result<ParsedTable, FileRefusal> | Promise<Result<ParsedTable, FileRefusal>>;
}

/**
 * The CSV parser: UTF-8 text, a comma between cells, a header row. A byte order mark is allowed.
 * The reading itself is the shared `@mondapac/platform-import` package (design 14b), the same code
 * the seller panel runs in the browser; this adapter only adds the format.
 */
export const csvParser: ImportFileParser = Object.freeze({
  format: 'csv',
  sniff: looksLikeText,
  parse(bytes: Uint8Array, limits: ImportLimits): Result<ParsedTable, FileRefusal> {
    const read = parseCsvBytes(bytes, limits);
    return read.ok ? ok({ format: 'csv', ...read.value }) : err(read.error);
  },
} satisfies ImportFileParser);

/**
 * The parsers the domain itself provides: CSV. The XLSX parser needs a library, so it lives in
 * infrastructure and the module hands the use cases `[csvParser, xlsxParser]` (token `IMPORT_PARSERS`).
 */
export const IMPORT_PARSERS: readonly ImportFileParser[] = Object.freeze([csvParser]);

/**
 * Reads an uploaded file: the size first, then the content sniff, then the parser's own limits.
 * The file name and the declared content type are never inputs. A file that is a format without a
 * parser (a ZIP container when no XLSX parser is given) is `file.unsupported-type`, so the page can say what to choose instead.
 */
export async function readImportFile(
  bytes: Uint8Array,
  limits: ImportLimits = IMPORT_LIMITS,
  parsers: readonly ImportFileParser[] = IMPORT_PARSERS,
): Promise<Result<ParsedTable, FileRefusal>> {
  if (bytes.length === 0) return err({ code: 'file.empty' });
  if (bytes.length > limits.fileBytes) {
    return err({ code: 'file.too-large', maxBytes: limits.fileBytes });
  }
  const parser = parsers.find((candidate) => candidate.sniff(bytes));
  if (parser === undefined) {
    return err({
      code: 'file.unsupported-type',
      detected: isZipContainer(bytes) ? 'xlsx' : 'other',
    });
  }
  const table = await parser.parse(bytes, limits);
  if (!table.ok) return table;
  if (table.value.rowCount > limits.rows) {
    return err({ code: 'file.too-many-rows', rows: table.value.rowCount, max: limits.rows });
  }
  if (table.value.header.length === 0 || table.value.rowCount === 0) {
    return err({ code: 'file.no-rows' });
  }
  return table;
}
