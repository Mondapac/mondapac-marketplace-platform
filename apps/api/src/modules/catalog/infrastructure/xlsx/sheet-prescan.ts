import type { FileRefusal } from '../../domain/platform-import/import-file';
import type { ImportLimits } from '../../domain/platform-import/limits';

const LT = 0x3c; // <
const GT = 0x3e; // >
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const QUOTES = new Set([0x22, 0x27]);
const BLANKS = new Set([0x20, 0x09, 0x0d, 0x0a]);

/** A start tag longer than this is no tag of a sheet (the longest real one holds a few attributes). */
const MAX_TAG_BYTES = 4096;
/** The longest tag name that is looked at; a longer one is some other element. */
const MAX_NAME_BYTES = 64;

/** The row number of a `<row r="...">` start tag: none, a number, or text that is no number. */
function rowNumberOf(attributes: string): number | null | 'not-a-number' | 'huge' {
  const found = /(?:^|\s)r\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attributes);
  if (found === null) return null;
  const text = found[1] ?? found[2] ?? '';
  if (!/^\d+$/.test(text)) return 'not-a-number';
  const digits = text.replace(/^0+/, '');
  // More than 15 digits is past any safe integer: no need to turn it into a number.
  if (digits.length > 15) return 'huge';
  return Number(digits);
}

/**
 * A cheap pass over the sheet XML that is already in memory, **before** exceljs sees it (Hassan
 * M-586-1, M-586-4). exceljs turns every SAX event of a chunk into objects, so a sheet that is
 * within the size limits but holds a great many `<row>` or `<c>` elements, or a row whose number is
 * far past the job table, costs far more memory than its bytes. This pass reads bytes only, keeps
 * no element, and refuses:
 *  - a row (the header included) whose `r` is past `limits.rows + 2`, the last row number the job
 *    table holds, or that is no whole number (`file.too-many-rows` / `file.unreadable`);
 *  - more `<row>` elements than there are such row numbers (`file.too-many-rows`);
 *  - more than twice the column limit of `<c>` elements in one row (`file.too-many-columns`).
 * Start tags are found by their `<` (a `<` cannot appear in an attribute value in well-formed XML,
 * and a tag hidden in a comment or CDATA section is hidden from the SAX parser as well, so the
 * count can be too high, never too low). A name with a namespace prefix counts by its local part.
 * Returns the refusal, or null when the sheet may go on to the reader.
 */
export function prescanSheet(xml: Uint8Array, limits: ImportLimits): FileRefusal | null {
  const bytes = Buffer.from(xml.buffer, xml.byteOffset, xml.byteLength);
  const lastRowNumber = limits.rows + 2;
  const maxCellsInRow = 2 * limits.columns;
  const tooManyRows: FileRefusal = {
    code: 'file.too-many-rows',
    rows: limits.rows + 1,
    max: limits.rows,
  };
  let rows = 0;
  let cells = 0;
  let at = 0;
  for (;;) {
    const open = bytes.indexOf(LT, at);
    if (open === -1 || open + 1 >= bytes.length) return null;
    const first = bytes[open + 1]!;
    if (first === SLASH || first === BANG || first === QUESTION) {
      at = open + 2;
      continue;
    }
    // The name: up to a blank, `>` or `/`.
    let nameEnd = open + 1;
    const nameLimit = Math.min(bytes.length, open + 1 + MAX_NAME_BYTES);
    while (nameEnd < nameLimit) {
      const byte = bytes[nameEnd]!;
      if (BLANKS.has(byte) || byte === GT || byte === SLASH) break;
      nameEnd += 1;
    }
    const name = bytes.latin1Slice(open + 1, nameEnd);
    const local = name.slice(name.lastIndexOf(':') + 1);
    if (local !== 'row' && local !== 'c') {
      at = nameEnd;
      continue;
    }
    if (local === 'c') {
      cells += 1;
      if (cells > maxCellsInRow) return { code: 'file.too-many-columns', max: limits.columns };
      at = nameEnd;
      continue;
    }
    // A row: its start tag to the closing `>`, outside quotes.
    let end = nameEnd;
    let quote = 0;
    const tagLimit = Math.min(bytes.length, nameEnd + MAX_TAG_BYTES);
    while (end < tagLimit) {
      const byte = bytes[end]!;
      if (quote !== 0) {
        if (byte === quote) quote = 0;
      } else if (QUOTES.has(byte)) {
        quote = byte;
      } else if (byte === GT) {
        break;
      }
      end += 1;
    }
    if (end >= tagLimit) return { code: 'file.unreadable' };
    rows += 1;
    if (rows > lastRowNumber) return tooManyRows;
    const number = rowNumberOf(bytes.latin1Slice(nameEnd, end));
    if (number === 'not-a-number') return { code: 'file.unreadable' };
    if (number === 'huge') return tooManyRows;
    if (number !== null) {
      if (number < 1) return { code: 'file.unreadable' };
      if (number > lastRowNumber) return tooManyRows;
    }
    cells = 0;
    at = end + 1;
  }
}
