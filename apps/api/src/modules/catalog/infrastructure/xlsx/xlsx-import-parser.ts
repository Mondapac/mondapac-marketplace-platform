import { Workbook } from 'exceljs';
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

/**
 * The XLSX parser (catalog design 14a), behind the same seam as CSV. It never sees a file the
 * container checks refused ({@link inspectXlsxContainer}: sizes, ratio, structure, type). Then:
 * the **first worksheet** only; **no formula** (a formula cell is `file.formula-cell`, nothing is
 * calculated or taken from a cached result); links give their text and are never followed; every
 * value becomes text deterministically (numbers shortest round-trip, dates as UTC ISO, booleans
 * `TRUE`/`FALSE`); a cell over the character limit, a header over the column limit and rows over the
 * row limit are refused as for CSV. Row numbers are the numbers the spreadsheet shows. exceljs reads
 * the already bounded container (at most 50 MiB unpacked) into memory; it makes no network call.
 */
export const xlsxParser: ImportFileParser = Object.freeze({
  format: 'xlsx',
  sniff: isZipContainer,
  async parse(bytes: Uint8Array, limits: ImportLimits): Promise<Result<ParsedTable, FileRefusal>> {
    const inspected = await inspectXlsxContainer(bytes, limits);
    if (!inspected.ok) return inspected;

    const workbook = new Workbook();
    try {
      await workbook.xlsx.load(
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) as never,
      );
    } catch {
      return err({ code: 'file.unreadable' });
    }
    const sheet = workbook.worksheets[0];
    if (sheet === undefined) return err({ code: 'file.unreadable' });

    const header: string[] = [];
    const rows: ParsedRow[] = [];
    let rowCount = 0;
    let isHeader = true;
    try {
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const { cells, width } = cellsOf(row, limits);
        if (width === 0) return; // a blank row is skipped, as in a CSV
        if (isHeader) {
          if (width > limits.columns) {
            throw new Refused({ code: 'file.too-many-columns', max: limits.columns });
          }
          header.push(...cells);
          isHeader = false;
          return;
        }
        rowCount += 1;
        if (rows.length < limits.rows) {
          const kept = cells.slice(0, header.length);
          while (kept.length < header.length) kept.push('');
          rows.push({ rowNumber: row.number, cells: kept });
        }
      });
    } catch (error) {
      if (error instanceof Refused) return err(error.refusal);
      return err({ code: 'file.unreadable' });
    }
    return ok({ format: 'xlsx', header, rows, rowCount });
  },
} satisfies ImportFileParser);
