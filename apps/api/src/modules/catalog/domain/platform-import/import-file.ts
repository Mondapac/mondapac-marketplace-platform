import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { IMPORT_LIMITS, type ImportLimits } from './limits';

/** The formats a parser may read. Only `csv` has a parser today; the repository has no spreadsheet library. */
export const IMPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

/** One data row. `rowNumber` is the number a spreadsheet shows: the header is row 1. */
export interface ParsedRow {
  readonly rowNumber: number;
  /** One text per header column, padded with empty strings. Never evaluated, never trimmed here. */
  readonly cells: readonly string[];
}

export interface ParsedTable {
  readonly header: readonly string[];
  readonly rows: readonly ParsedRow[];
  /** Every non-blank data row of the file, also those past the row limit. */
  readonly rowCount: number;
}

/** Why a file was refused before any row was looked at. Codes and numbers only, never a value. */
export type FileRefusal =
  | { readonly code: 'file.empty' }
  | { readonly code: 'file.too-large'; readonly maxBytes: number }
  | { readonly code: 'file.unsupported-type'; readonly detected: ImportFormat | 'other' }
  | { readonly code: 'file.unreadable' }
  | { readonly code: 'file.too-many-columns'; readonly max: number }
  | { readonly code: 'file.cell-too-long'; readonly rowNumber: number; readonly max: number }
  | { readonly code: 'file.too-many-rows'; readonly rows: number; readonly max: number }
  | { readonly code: 'file.no-rows' };

/**
 * The seam for a file format (design 14a: pluggable). A parser answers whether the bytes are its
 * format from their content alone (never from the file name or the declared type) and reads them
 * into a table within the limits. A second parser (XLSX, once a library is approved) joins
 * {@link IMPORT_PARSERS}; nothing else changes: the checks read a {@link ParsedTable}.
 */
export interface ImportFileParser {
  readonly format: ImportFormat;
  /** True when the first bytes look like this format. A cheap look, no decode. */
  sniff(bytes: Uint8Array): boolean;
  parse(bytes: Uint8Array, limits: ImportLimits): Result<ParsedTable, FileRefusal>;
}

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((value, index) => bytes[index] === value);
}

/** Signatures of what is certainly not a CSV (the sniff reads content, never the name). */
const NOT_TEXT: readonly (readonly number[])[] = [
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x1f, 0x8b], // gzip
  [0xd0, 0xcf, 0x11, 0xe0], // legacy Office
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // MZ
  [0xff, 0xfe], // UTF-16 LE
  [0xfe, 0xff], // UTF-16 BE
];

/** Looks for a ZIP container, which is what an XLSX is. */
export function isZipContainer(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]);
}

const SNIFF_WINDOW = 8192;

/** True when the first bytes are text: no known binary signature, no NUL byte, no markup start. */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (NOT_TEXT.some((magic) => startsWith(bytes, magic)) || isZipContainer(bytes)) return false;
  const window = bytes.subarray(0, Math.min(bytes.length, SNIFF_WINDOW));
  if (window.includes(0)) return false;
  const head = Buffer.from(window.subarray(0, 64)).toString('latin1').trimStart().toLowerCase();
  return !(head.startsWith('<?xml') || head.startsWith('<html') || head.startsWith('<!doctype'));
}

/**
 * Tokenises RFC 4180 text. The limits are enforced while reading: a cell over the limit, too many
 * columns or an unterminated quote stop it at once; rows past the row limit are counted, not kept.
 */
function tokenise(text: string, limits: ImportLimits): Result<ParsedTable, FileRefusal> {
  const header: string[] = [];
  const rows: ParsedRow[] = [];
  let rowCount = 0;
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  let inQuotes = false;
  let wasQuoted = false;
  let recordNumber = 1;
  let isHeader = true;

  // A record is refused the moment it holds more cells than the column limit, header or data row:
  // a 10 MB line of commas never builds an array of millions of cells (Hassan L-585-4).
  const tooWide = (): Result<void, FileRefusal> =>
    err({ code: 'file.too-many-columns', max: limits.columns });
  const endCell = (): boolean => {
    record.push(cell);
    cell = '';
    wasQuoted = quoted;
    quoted = false;
    return record.length > limits.columns;
  };
  const endRecord = (): Result<void, FileRefusal> => {
    if (endCell()) return tooWide();
    const blank = record.length === 1 && record[0] === '' && !wasQuoted;
    if (!blank) {
      if (isHeader) {
        if (record.length > limits.columns) {
          return err({ code: 'file.too-many-columns', max: limits.columns });
        }
        header.push(...record);
        isHeader = false;
      } else {
        rowCount += 1;
        if (rows.length < limits.rows) {
          const cells = record.slice(0, header.length);
          while (cells.length < header.length) cells.push('');
          rows.push({ rowNumber: recordNumber, cells });
        }
      }
    }
    record = [];
    recordNumber += 1;
    return ok(undefined);
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else inQuotes = false;
      } else cell += char;
    } else if (char === '"' && cell === '') {
      inQuotes = true;
      quoted = true;
    } else if (char === ',') {
      if (endCell()) return err({ code: 'file.too-many-columns', max: limits.columns });
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      const ended = endRecord();
      if (!ended.ok) return ended;
      continue;
    } else cell += char;
    if (cell.length > limits.cellChars) {
      return err({ code: 'file.cell-too-long', rowNumber: recordNumber, max: limits.cellChars });
    }
  }
  if (inQuotes) return err({ code: 'file.unreadable' });
  if (cell !== '' || record.length > 0 || quoted) {
    const ended = endRecord();
    if (!ended.ok) return ended;
  }
  return ok({ header, rows, rowCount });
}

/** The CSV parser: UTF-8 text, a comma between cells, a header row. A byte order mark is allowed. */
export const csvParser: ImportFileParser = Object.freeze({
  format: 'csv',
  sniff: looksLikeText,
  parse(bytes: Uint8Array, limits: ImportLimits): Result<ParsedTable, FileRefusal> {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return err({ code: 'file.unreadable' });
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return tokenise(text, limits);
  },
} satisfies ImportFileParser);

/** The parsers that read a format today. An XLSX parser is added here, behind the same interface. */
export const IMPORT_PARSERS: readonly ImportFileParser[] = Object.freeze([csvParser]);

/**
 * Reads an uploaded file: the size first, then the content sniff, then the parser's own limits.
 * The file name and the declared content type are never inputs. A file that is a format without a
 * parser (an XLSX today) is `file.unsupported-type`, so the page can say what to choose instead.
 */
export function readImportFile(
  bytes: Uint8Array,
  limits: ImportLimits = IMPORT_LIMITS,
  parsers: readonly ImportFileParser[] = IMPORT_PARSERS,
): Result<ParsedTable, FileRefusal> {
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
  const table = parser.parse(bytes, limits);
  if (!table.ok) return table;
  if (table.value.rowCount > limits.rows) {
    return err({ code: 'file.too-many-rows', rows: table.value.rowCount, max: limits.rows });
  }
  if (table.value.header.length === 0 || table.value.rowCount === 0) {
    return err({ code: 'file.no-rows' });
  }
  return table;
}
