import { Readable } from 'node:stream';
import { stream as excel } from 'exceljs';
import type { CellValue, Row } from 'exceljs';
import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import {
  isZipContainer,
  type FileRefusal,
  type ImportFileParser,
  type ParsedRow,
  type ParsedTable,
} from '../../domain/platform-import/import-file';
import type { ImportLimits } from '../../domain/platform-import/limits';
import { prescanSheet } from './sheet-prescan';
import { storedZip, type StoredPart } from './stored-zip';
import { inspectXlsxContainer } from './zip-inspection';

/** A cell that cannot be turned into text, or a formula; the parse stops at the first one. */
class Refused extends Error {
  constructor(readonly refusal: FileRefusal) {
    super(refusal.code);
  }
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/**
 * A date as text, the same for the same cell on every machine: the UTC calendar date
 * (`2026-10-31`) when the time is midnight, else the UTC date and time to the second
 * (`2026-10-31T13:45:00Z`). The server's time zone is never read.
 */
export function dateText(value: Date): string {
  if (Number.isNaN(value.getTime())) return '';
  const date = `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  const time = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
  return time === '00:00:00' && value.getUTCMilliseconds() === 0 ? date : `${date}T${time}Z`;
}

/** A number as text: the shortest form that reads back as the same number (`5901234123457`, `0.5`). */
export function numberText(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

/**
 * One cell as text. A formula (`formula`, `sharedFormula`) is refused: only values that sit in the
 * file are read, so what the admin checks is what the file holds, never the result of a calculation.
 * Rich text and a link give their visible text only; the link's target is never read.
 */
function textOf(value: CellValue, rowNumber: number): string {
  if (value === null || value === undefined) return '';
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      return numberText(value);
    case 'boolean':
      return value ? 'TRUE' : 'FALSE';
    default:
      break;
  }
  if (value instanceof Date) return dateText(value);
  const object = value as unknown as Record<string, unknown>;
  if ('formula' in object || 'sharedFormula' in object) {
    throw new Refused({ code: 'file.formula-cell', rowNumber });
  }
  if (Array.isArray(object['richText'])) {
    return (object['richText'] as { text?: unknown }[])
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  if ('hyperlink' in object) {
    const shown = object['text'];
    if (typeof shown === 'string') return shown;
    if (shown !== null && typeof shown === 'object') return textOf(shown as CellValue, rowNumber);
    return '';
  }
  if (typeof object['error'] === 'string') return object['error'];
  return '';
}

/** The text cells of a row, from column 1 up to its last non-empty cell; checked against the limits. */
function cellsOf(row: Row, limits: ImportLimits): { cells: string[]; width: number } {
  const cells: string[] = [];
  let last = 0;
  row.eachCell({ includeEmpty: false }, (cell, column) => {
    const text = textOf(cell.value, row.number);
    if (text.length > limits.cellChars) {
      throw new Refused({
        code: 'file.cell-too-long',
        rowNumber: row.number,
        max: limits.cellChars,
      });
    }
    if (text === '') return;
    if (column > limits.columns) {
      // Past the column limit is only a refusal in the header; a data cell there is just ignored.
      last = Math.max(last, column);
      return;
    }
    while (cells.length < column) cells.push('');
    cells[column - 1] = text;
    last = Math.max(last, column);
  });
  cells.length = Math.min(last, cells.length);
  return { cells, width: last };
}

const EMPTY_SHARED_STRINGS = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="0" uniqueCount="0"/>',
);
const EMPTY_RELATIONSHIPS = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
);

const WORKBOOK = 'xl/workbook.xml';
const WORKBOOK_RELS = 'xl/_rels/workbook.xml.rels';
const SHARED_STRINGS = 'xl/sharedStrings.xml';
const STYLES = 'xl/styles.xml';
const WORKSHEET = /^xl\/worksheets\/[^/]+\.xml$/;

/** The parts the streaming read needs; the others were checked and are let go. */
const wanted = (name: string): boolean =>
  name === WORKBOOK ||
  name === WORKBOOK_RELS ||
  name === SHARED_STRINGS ||
  name === STYLES ||
  WORKSHEET.test(name);

/** The part name of the first sheet of the workbook, in the order the workbook lists them. */
function firstSheetPart(workbookXml: string, relsXml: string): string | null {
  const sheet = /<sheet\b[^>]*>/i.exec(workbookXml)?.[0];
  if (sheet === undefined) return null;
  const rid = /\s[\w.-]+:id\s*=\s*"([^"]*)"/i.exec(sheet)?.[1];
  if (rid === undefined) return null;
  for (const tag of relsXml.match(/<Relationship\b[^>]*>/gi) ?? []) {
    if (/\bId\s*=\s*"([^"]*)"/i.exec(tag)?.[1] !== rid) continue;
    const target = /\bTarget\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (target === undefined) return null;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    return WORKSHEET.test(path) ? path : null;
  }
  return null;
}

/** A cell for the canonical CSV: RFC 4180 quoting; nothing is trimmed, prefixed or evaluated. */
function canonicalCell(value: string): string {
  return /[",\r\n\uFEFF]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The byte order mark the canonical CSV starts with. */
const BOM_BYTES = 3;

/** The bytes one line takes in the canonical CSV, with its CRLF; `cells` are the line's cells. */
function canonicalLineBytes(cells: readonly string[]): number {
  let bytes = 2; // CRLF
  let inner = Math.max(0, cells.length - 1); // the commas
  for (const cell of cells) inner += Buffer.byteLength(canonicalCell(cell), 'utf8');
  // A row whose cells are all empty is written as `""`.
  bytes += inner === 0 ? 2 : inner;
  return bytes;
}

/**
 * The table as plain CSV bytes (a byte order mark, then RFC 4180 text), one line per spreadsheet
 * row so that row numbers read back the same: a skipped blank row is an empty line. This is what
 * the import stores for an XLSX: the workbook is opened **once**, at the check, and every worker
 * turn reads this text, never the container again.
 */
function canonicalCsv(header: readonly string[], headerRow: number, rows: readonly ParsedRow[]) {
  const lines: string[] = [];
  let last = 0;
  const add = (rowNumber: number, cells: readonly string[]): void => {
    for (let gap = last + 1; gap < rowNumber; gap += 1) lines.push('');
    const line = cells.map(canonicalCell).join(',');
    // A row whose cells are all empty must not read back as a blank line.
    lines.push(line === '' ? '""' : line);
    last = rowNumber;
  };
  add(headerRow, header);
  for (const row of rows) add(row.rowNumber, row.cells);
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

/** The reader's input chunk size: the events in flight at once are those of one slice. */
export const READ_SLICE_BYTES = 64 * 1024;

function* slices(bytes: Buffer): Generator<Buffer> {
  for (let at = 0; at < bytes.length; at += READ_SLICE_BYTES) {
    yield bytes.subarray(at, at + READ_SLICE_BYTES);
  }
}

/** Called with the number of each sheet row the reader hands over (a test sees where it stopped). */
export type RowObserver = (rowNumber: number) => void;

/**
 * The XLSX parser (catalog design 14a), behind the same seam as CSV. It never sees a file the
 * container checks refused ({@link inspectXlsxContainer}: sizes per part and in total, ratio,
 * structure, type, no DTD anywhere in an XML part). Then, **streaming** (Hassan M-586-1):
 * exceljs's `WorkbookReader` is given a small ZIP of only the workbook, the shared strings, the
 * styles and the **first worksheet** (the first the workbook lists), and the rows are read as they
 * come, so memory holds a row, not the sheet. Reading **stops** at the first data row past the
 * row limit (5,001 data rows, or a row past number 5,002, which the job table cannot hold), and
 * the file is refused as too many rows. **No formula** (a formula cell is `file.formula-cell`,
 * nothing is calculated or taken from a cached result); links give their text and are never
 * followed; every value becomes text deterministically (numbers shortest round-trip, dates as UTC
 * ISO, booleans `TRUE`/`FALSE`); a cell over the character limit and a header over the column limit
 * are refused as for CSV. Row numbers are the numbers the spreadsheet shows. exceljs makes no
 * network call. The table comes with its {@link ParsedTable.canonical} CSV, which the check stores
 * instead of the workbook.
 */
export function createXlsxParser(observe?: RowObserver): ImportFileParser {
  return Object.freeze({
    format: 'xlsx',
    sniff: isZipContainer,
    async parse(
      bytes: Uint8Array,
      limits: ImportLimits,
    ): Promise<Result<ParsedTable, FileRefusal>> {
      const inspected = await inspectXlsxContainer(bytes, limits, wanted);
      if (!inspected.ok) return inspected;
      const { parts } = inspected.value;

      const decode = (name: string): string => Buffer.from(parts.get(name) ?? []).toString('utf8');
      const sheetName = firstSheetPart(decode(WORKBOOK), decode(WORKBOOK_RELS));
      const sheet = sheetName === null ? undefined : parts.get(sheetName);
      if (sheet === undefined) return err({ code: 'file.unreadable' });
      // Before exceljs sees a byte: a row number or an element count that could never fit the
      // limits is refused from the bytes already in memory (Hassan M-586-1, M-586-4).
      const refused = prescanSheet(sheet, limits);
      if (refused !== null) return err(refused);

      // The parts in the order the reader needs: shared strings and styles before the sheet.
      const ordered: StoredPart[] = [
        { name: WORKBOOK_RELS, data: EMPTY_RELATIONSHIPS },
        { name: WORKBOOK, data: parts.get(WORKBOOK) ?? Buffer.alloc(0) },
        { name: SHARED_STRINGS, data: parts.get(SHARED_STRINGS) ?? EMPTY_SHARED_STRINGS },
        ...(parts.has(STYLES)
          ? [{ name: STYLES, data: parts.get(STYLES) ?? Buffer.alloc(0) }]
          : []),
        { name: 'xl/worksheets/sheet1.xml', data: sheet },
      ];
      // Small slices, not one buffer: exceljs turns every SAX event of a chunk into objects before
      // it yields any, so a whole sheet in one chunk costs far more memory than its bytes.
      const input = Readable.from(slices(storedZip(ordered)));
      const reader = new excel.xlsx.WorkbookReader(input, {
        worksheets: 'emit',
        sharedStrings: 'cache',
        hyperlinks: 'ignore',
        styles: 'cache',
        entries: 'ignore',
      });

      const header: string[] = [];
      const rows: ParsedRow[] = [];
      // A running count of the bytes the canonical CSV will take (Hassan M-586-5): shared strings
      // are cached, so many cells can point at one long string and the text would be far larger
      // than the file. It is checked as each row is kept, before the text is built.
      let canonicalBytes = BOM_BYTES;
      let lastKept = 0;
      const spend = (rowNumber: number, cells: readonly string[]): void => {
        canonicalBytes += (rowNumber - lastKept - 1) * 2 + canonicalLineBytes(cells);
        lastKept = rowNumber;
        if (canonicalBytes > limits.fileBytes) {
          throw new Refused({ code: 'file.too-large', maxBytes: limits.fileBytes });
        }
      };
      let headerRow = 0;
      let rowCount = 0;
      let isHeader = true;
      // The job table holds rows 2 to 5,002; a data row past that is more than it can take.
      const lastRowNumber = limits.rows + 2;
      try {
        for await (const worksheet of reader) {
          for await (const row of worksheet) {
            if (!Number.isSafeInteger(row.number) || row.number < 1) {
              return err({ code: 'file.unreadable' });
            }
            // The header too: a number past the job table is refused before anything is built
            // from it (Hassan M-586-4; the canonical CSV keeps one line per skipped row).
            if (row.number > lastRowNumber) {
              return err({
                code: 'file.too-many-rows',
                rows: limits.rows + 1,
                max: limits.rows,
              });
            }
            observe?.(row.number);
            const { cells, width } = cellsOf(row, limits);
            if (width === 0) continue; // a blank row is skipped, as in a CSV
            if (isHeader) {
              if (width > limits.columns) {
                throw new Refused({ code: 'file.too-many-columns', max: limits.columns });
              }
              spend(row.number, cells);
              header.push(...cells);
              headerRow = row.number;
              isHeader = false;
              continue;
            }
            rowCount += 1;
            if (rowCount > limits.rows || row.number > lastRowNumber) {
              // Stop here: the rest of the sheet is neither read nor counted.
              rowCount = limits.rows + 1;
              break;
            }
            const kept = cells.slice(0, header.length);
            while (kept.length < header.length) kept.push('');
            spend(row.number, kept);
            rows.push({ rowNumber: row.number, cells: kept });
          }
          break; // the first worksheet only
        }
        if (rowCount > limits.rows) {
          return ok({ format: 'xlsx', header, rows: [], rowCount });
        }
        // Inside the try: nothing thrown while the text is built escapes `parse` (M-586-5).
        const canonical = canonicalCsv(header, headerRow, rows);
        if (canonical.length > limits.fileBytes) {
          return err({ code: 'file.too-large', maxBytes: limits.fileBytes });
        }
        return ok({ format: 'xlsx', header, rows, rowCount, canonical });
      } catch (error) {
        if (error instanceof Refused) return err(error.refusal);
        if (error instanceof RangeError) {
          return err({ code: 'file.too-large', maxBytes: limits.fileBytes });
        }
        return err({ code: 'file.unreadable' });
      } finally {
        input.destroy();
      }
    },
  } satisfies ImportFileParser);
}

/** The parser the use cases are given. */
export const xlsxParser: ImportFileParser = createXlsxParser();
