import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { CSV_BOM, csvLine } from '@mondapac/platform-import';
import { XLSX_CONTENT_TYPE, type SheetWriter } from './sheet-writer';

// The shared export of every super list (docs: super list phase 0, B0-3): the format choice, the
// chosen columns, the row cap and the file in chunks. A module keeps what its rows are; this file
// owns how they leave. Pure text functions and one builder, no I/O of its own.

export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Rows one export may hold; more is refused whole (`batch.too-large`) and the user narrows it. */
export const LIST_EXPORT_MAX_ROWS = 10_000;

/** One cell of a row before it is written: text, a count or nothing. */
export type ExportCell = string | number | null;

/** The refusal of an export that holds more rows than the cap. */
export interface ExportTooLarge {
  readonly code: 'batch.too-large';
  readonly max: number;
  readonly total?: number;
}

/** A request the export does not accept: the field and the reason (the shape modules use). */
export interface ExportInputFailure {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

const failed = (path: string, code: string): { ok: false; error: ExportInputFailure } => ({
  ok: false,
  error: { code: 'validation.failed', fields: [{ path, code }] },
});

/** `format`: absent means CSV; anything but `csv` or `xlsx` is refused. */
export function parseExportFormat(value: unknown): Result<ExportFormat, ExportInputFailure> {
  if (value === undefined) return ok('csv');
  if (value === 'csv' || value === 'xlsx') return ok(value);
  return failed('format', 'value');
}

/**
 * `columns`: a comma-separated list of optional columns in the order shown (the list's column
 * picker). Every name must be one of `allowed`; a repeated name counts once. Absent is none.
 */
export function parseExportColumns<C extends string>(
  value: unknown,
  allowed: readonly C[],
): Result<readonly C[], ExportInputFailure> {
  if (value === undefined || value === '') return ok([]);
  if (typeof value !== 'string') return failed('columns', 'type');
  const seen = new Set<C>();
  for (const part of value.split(',')) {
    const column = allowed.find((candidate) => candidate === part);
    if (column === undefined) return failed('columns', 'value');
    seen.add(column);
  }
  return ok([...seen]);
}

/**
 * `ids`: a comma-separated list of the selected rows' ids, at most `max` (the bulk limit of the
 * list). Each id goes through the module's own `toId` (null refuses it); a repeat is refused.
 */
export function parseExportIds<T>(
  value: string,
  max: number,
  toId: (part: string) => T | null,
): Result<readonly T[], ExportInputFailure | ExportTooLarge> {
  const parts = value.split(',');
  if (parts.length > max) return err({ code: 'batch.too-large', max });
  const ids: T[] = [];
  for (const part of parts) {
    const id = toId(part);
    if (id === null) return failed('ids', 'format');
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) return failed('ids', 'duplicate');
  return ok(ids);
}

/**
 * Whether a selection fits the cap. `found` is how many rows were read with a limit of
 * {@link LIST_EXPORT_MAX_ROWS} plus one; `total` is the full count, read only when it overflowed.
 */
export function checkExportSize(found: number, total?: number): Result<true, ExportTooLarge> {
  if (found <= LIST_EXPORT_MAX_ROWS) return ok(true);
  return err({
    code: 'batch.too-large',
    max: LIST_EXPORT_MAX_ROWS,
    ...(total === undefined ? {} : { total }),
  });
}

/** CSV: the byte order mark before the header, then each group of rows as one chunk of lines. */
export async function* csvChunks(
  groups: AsyncIterable<readonly (readonly ExportCell[])[]>,
): AsyncGenerator<string> {
  let first = true;
  for await (const group of groups) {
    const text = group.map((row) => csvLine(row)).join('');
    yield first ? CSV_BOM + text : text;
    first = false;
  }
}

/** XLSX: every cell as text; a count is written as the digits, nothing is a number or formula. */
export async function* textRows(
  groups: AsyncIterable<readonly (readonly ExportCell[])[]>,
): AsyncGenerator<readonly string[]> {
  for await (const group of groups) {
    for (const row of group) yield row.map((cell) => (cell === null ? '' : String(cell)));
  }
}

export interface ExportFileRequest {
  readonly format: ExportFormat;
  /** The file name without the day and extension, for example `products`. */
  readonly baseName: string;
  /** The sheet name of an XLSX file. */
  readonly sheetName: string;
  /** The day, `YYYY-MM-DD`, from the injected clock. */
  readonly day: string;
  /** The rows, a group per page read; the header group first. */
  readonly groups: AsyncIterable<readonly (readonly ExportCell[])[]>;
  readonly sheetWriter: SheetWriter;
}

export interface ExportFile {
  readonly filename: string;
  readonly contentType: string;
  /** Text for a CSV, bytes for an XLSX. */
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

/** The file of an export: the same rows as CSV (formula-guarded) or XLSX (every cell a string). */
export function buildExportFile(request: ExportFileRequest): ExportFile {
  const stem = `${request.baseName}-${request.day}`;
  if (request.format === 'xlsx') {
    return {
      filename: `${stem}.xlsx`,
      contentType: XLSX_CONTENT_TYPE,
      chunks: request.sheetWriter.xlsx(request.sheetName, textRows(request.groups)),
    };
  }
  return {
    filename: `${stem}.csv`,
    contentType: 'text/csv; charset=utf-8',
    chunks: csvChunks(request.groups),
  };
}
