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

/** The only form of a cell reference a sheet holds (Excel and LibreOffice write exactly this). */
const CELL_REFERENCE = /^([A-Z]{1,3})[1-9][0-9]*$/;

/**
 * The 1-based column of a `<c r="...">` start tag (`A` is 1, `AA` is 27), `null` when the tag has
 * no `r`, and `'invalid'` when the reference is not exactly one to three capital letters then a
 * positive number (Hassan L-586-6). The prescan must be as strict as the most lenient reader that
 * follows it: exceljs skips every character that is not a letter or a digit, so `$XFD$2`,
 * ` XFD2` and `-XFD2` are column 16,384 to it. A reference like that is refused, not read.
 */
function columnOf(attributes: string): number | null | 'invalid' {
  const found = /(?:^|\s)r\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attributes);
  if (found === null) return null;
  const letters = CELL_REFERENCE.exec(found[1] ?? found[2] ?? '')?.[1];
  if (letters === undefined) return 'invalid';
  let column = 0;
  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64);
  return column;
}

/** The index of the `>` that ends a start tag whose name ended at `from`, or -1 (no end in reach). */
function tagEndOf(bytes: Buffer, from: number): number {
  let end = from;
  let quote = 0;
  const tagLimit = Math.min(bytes.length, from + MAX_TAG_BYTES);
  while (end < tagLimit) {
    const byte = bytes[end]!;
    if (quote !== 0) {
      if (byte === quote) quote = 0;
    } else if (QUOTES.has(byte)) {
      quote = byte;
    } else if (byte === GT) {
      return end;
    }
    end += 1;
  }
  return -1;
}

/**
 * The next start tag at or after `at`: its local name (a namespace prefix is dropped) and the index
 * where its name ended, or null at the end. Closing tags, comments, CDATA and declarations are
 * skipped. Start tags are found by their `<` (a `<` cannot appear in an attribute value in
 * well-formed XML, and a tag hidden in a comment or CDATA section is hidden from the SAX parser as
 * well, so a count can be too high, never too low).
 */
function nextStartTag(bytes: Buffer, from: number): { local: string; nameEnd: number } | null {
  let at = from;
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
    const name = bytes.toString('latin1', open + 1, nameEnd);
    return { local: name.slice(name.lastIndexOf(':') + 1), nameEnd };
  }
}

/** A string (`<si>` of the shared strings, `<is>` of a cell) with more runs than this is too complex. */
const tooComplex: FileRefusal = { code: 'file.too-complex' };

/**
 * A cheap pass over the shared strings part, before exceljs sees it (Hassan M-586-8): a rich
 * string is one `<si>` of `<r>` runs, and an empty run is four bytes (`<r/>`), so the number of
 * runs is bounded only by the part's size. A string with more than `limits.runsPerString` runs,
 * empty ones counted, is `file.too-complex`. Returns the refusal, or null.
 */
export function prescanSharedStrings(xml: Uint8Array, limits: ImportLimits): FileRefusal | null {
  const bytes = Buffer.from(xml.buffer, xml.byteOffset, xml.byteLength);
  let runs = 0;
  let at = 0;
  for (;;) {
    const tag = nextStartTag(bytes, at);
    if (tag === null) return null;
    at = tag.nameEnd;
    if (tag.local === 'si') runs = 0;
    else if (tag.local === 'r') {
      runs += 1;
      if (runs > limits.runsPerString) return tooComplex;
    }
  }
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
 *  - more than twice the column limit of `<c>` elements in one row (`file.too-many-columns`);
 *  - a `<c>` whose reference is not one to three capital letters then a positive number
 *    (`file.unreadable`, Hassan L-586-6);
 *  - a `<c>` whose reference is in a column past twice the column limit (`file.too-many-columns`,
 *    Hassan L-586-6): exceljs sizes a row's cell array up to its last column and walks it, so a few
 *    cells in column XFD cost seconds of CPU on the event loop. A column past that limit is
 *    ignored for data anyway, and a header past it is refused;
 *  - an inline string with more runs than `limits.runsPerString` (`file.too-complex`, M-586-8).
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
  let runs = 0;
  let at = 0;
  for (;;) {
    const tag = nextStartTag(bytes, at);
    if (tag === null) return null;
    const { local, nameEnd } = tag;
    if (local === 'r') {
      runs += 1;
      if (runs > limits.runsPerString) return tooComplex;
    }
    if (local !== 'row' && local !== 'c') {
      at = nameEnd;
      continue;
    }
    if (local === 'c') {
      cells += 1;
      runs = 0;
      if (cells > maxCellsInRow) return { code: 'file.too-many-columns', max: limits.columns };
      const cellEnd = tagEndOf(bytes, nameEnd);
      if (cellEnd === -1) return { code: 'file.unreadable' };
      const column = columnOf(bytes.toString('latin1', nameEnd, cellEnd));
      if (column === 'invalid') return { code: 'file.unreadable' };
      if (column !== null && column > maxCellsInRow) {
        return { code: 'file.too-many-columns', max: limits.columns };
      }
      at = cellEnd + 1;
      continue;
    }
    // A row: its start tag to the closing `>`, outside quotes.
    const end = tagEndOf(bytes, nameEnd);
    if (end === -1) return { code: 'file.unreadable' };
    rows += 1;
    if (rows > lastRowNumber) return tooManyRows;
    const number = rowNumberOf(bytes.toString('latin1', nameEnd, end));
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
