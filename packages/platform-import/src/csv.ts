// The CSV reader of the import files (catalog design 14 and 14b): UTF-8, comma separated, a header
// row, a byte order mark accepted, formulas never evaluated, a cell never trimmed. The limits are
// enforced while reading, so a hostile file never builds a large structure. No Node API is used:
// the same code runs in the API and in the seller's browser.

/** What the reader needs of an import's limits (the API passes its wider limits object). */
export interface CsvLimits {
  /** Data rows kept; rows past it are counted, not kept. */
  readonly rows: number;
  /** Columns in the header row and in any data row. */
  readonly columns: number;
  /** Characters in one cell. */
  readonly cellChars: number;
}

/** One data row. `rowNumber` is the number a spreadsheet shows: the header is row 1. */
export interface CsvRow {
  readonly rowNumber: number;
  /** One text per header column, padded with empty strings. Never evaluated, never trimmed. */
  readonly cells: readonly string[];
}

export interface CsvTable {
  readonly header: readonly string[];
  readonly rows: readonly CsvRow[];
  /** Every non-blank data row of the file, also those past the row limit. */
  readonly rowCount: number;
}

/** Why the text was refused. Codes and numbers only, never a value. */
export type CsvRefusal =
  | { readonly code: 'file.unreadable' }
  | { readonly code: 'file.too-many-columns'; readonly max: number }
  | { readonly code: 'file.cell-too-long'; readonly rowNumber: number; readonly max: number };

export type CsvResult =
  | { readonly ok: true; readonly value: CsvTable }
  | { readonly ok: false; readonly error: CsvRefusal };

/**
 * Tokenises RFC 4180 text. The limits are enforced while reading: a cell over the limit, too many
 * columns or an unterminated quote stop it at once; rows past the row limit are counted, not kept.
 */
export function tokeniseCsv(text: string, limits: CsvLimits): CsvResult {
  const header: string[] = [];
  const rows: CsvRow[] = [];
  let rowCount = 0;
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  let inQuotes = false;
  let wasQuoted = false;
  let recordNumber = 1;
  let isHeader = true;

  const tooWide: CsvResult = {
    ok: false,
    error: { code: 'file.too-many-columns', max: limits.columns },
  };
  const endCell = (): boolean => {
    record.push(cell);
    cell = '';
    wasQuoted = quoted;
    quoted = false;
    return record.length > limits.columns;
  };
  // A record is refused the moment it holds more cells than the column limit, header or data row:
  // a 10 MB line of commas never builds an array of millions of cells (Hassan L-585-4).
  const endRecord = (): CsvResult | null => {
    if (endCell()) return tooWide;
    const blank = record.length === 1 && record[0] === '' && !wasQuoted;
    if (!blank) {
      if (isHeader) {
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
    return null;
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
      if (endCell()) return tooWide;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      const refused = endRecord();
      if (refused !== null) return refused;
      continue;
    } else cell += char;
    if (cell.length > limits.cellChars) {
      return {
        ok: false,
        error: { code: 'file.cell-too-long', rowNumber: recordNumber, max: limits.cellChars },
      };
    }
  }
  if (inQuotes) return { ok: false, error: { code: 'file.unreadable' } };
  if (cell !== '' || record.length > 0 || quoted) {
    const refused = endRecord();
    if (refused !== null) return refused;
  }
  return { ok: true, value: { header, rows, rowCount } };
}

/** The CSV reader over bytes: UTF-8 (anything else is unreadable), a byte order mark allowed. */
export function parseCsvBytes(bytes: Uint8Array, limits: CsvLimits): CsvResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: { code: 'file.unreadable' } };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return tokeniseCsv(text, limits);
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
  const head = new TextDecoder('latin1').decode(window.subarray(0, 64)).trimStart().toLowerCase();
  return !(head.startsWith('<?xml') || head.startsWith('<html') || head.startsWith('<!doctype'));
}
