import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Clock, Result } from '@mondapac/shared-kernel';
import {
  buildExportFile,
  ExceljsSheetWriter,
  LIST_EXPORT_MAX_ROWS,
  parseExportColumns,
  parseExportFormat,
  parseExportIds,
} from '../../../platform/list-export';
import type { Cell } from './orders-csv';

/** Orders read per page while the file streams. */
export const EXPORT_PAGE = 100;
/** Selected rows one export may name: one list page at its largest (100 rows). */
export const ORDERS_EXPORT_MAX_IDS = 100;

const sheetWriter = new ExceljsSheetWriter();

export interface OrdersExportOutput {
  readonly filename: string;
  readonly contentType: string;
  /** The file in chunks, the header first: text for a CSV, bytes for an XLSX. */
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

export type OrdersExportFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly matching?: number }
  | { readonly code: 'ordering.order-not-found' | 'ordering.seller-order-not-found' };

/** One page of a list, as the export reads it. */
export interface ExportPage {
  readonly rows: readonly (readonly Cell[])[];
  readonly nextCursor: string | null;
  /** The rows matching the filter; set only on the page-mode read. */
  readonly total: number | null;
}

export type PageReader = (
  extra: Readonly<Record<string, unknown>>,
) => Promise<Result<ExportPage, { readonly code: string } & Record<string, unknown>>>;

/**
 * The export of a list: the filter keys are checked (`allowed`; any other key is refused), the
 * count is read first with a one-row page (more than {@link LIST_EXPORT_MAX_ROWS} is refused whole
 * as `batch.too-large`), and the file then streams a page of {@link EXPORT_PAGE} rows at a time
 * through the same list the page uses, so the rules, the filter and the population are the list's.
 */
export async function ordersExport(
  clock: Clock,
  input: unknown,
  spec: {
    readonly allowed: ReadonlySet<string>;
    readonly header: readonly string[];
    readonly name: string;
    readonly read: PageReader;
    /**
     * The columns of the file: the first `fixed` columns of a row always leave, `optional` names
     * the others by their place in the row. Without `columns` in the request every column leaves.
     */
    readonly columns: {
      readonly fixed: number;
      readonly optional: Readonly<Record<string, number>>;
    };
    /** The refusal for a selected id the list does not show. */
    readonly notFound: 'ordering.order-not-found' | 'ordering.seller-order-not-found';
  },
): Promise<Result<OrdersExportOutput, OrdersExportFailure>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err({ code: 'validation.failed', fields: [{ path: 'query', code: 'type' }] });
  }
  const filter: Record<string, unknown> = {};
  const unknown: { path: string; code: string }[] = [];
  let rawFormat: unknown;
  let rawColumns: unknown;
  let rawIds: unknown;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key === 'format') rawFormat = value;
    else if (key === 'columns') rawColumns = value;
    else if (key === 'ids') rawIds = value;
    else if (spec.allowed.has(key)) filter[key] = value;
    else unknown.push({ path: key.slice(0, 64), code: 'unknown' });
  }
  const format = parseExportFormat(rawFormat);
  if (!format.ok) unknown.push(...format.error.fields);
  const optionalKeys = Object.keys(spec.columns.optional);
  const chosen = parseExportColumns(rawColumns, optionalKeys);
  if (!chosen.ok) unknown.push(...chosen.error.fields);
  if (unknown.length > 0) return err({ code: 'validation.failed', fields: unknown.slice(0, 10) });
  if (!format.ok || !chosen.ok) return err({ code: 'validation.failed', fields: [] });
  // The place of every column that leaves, in the order of the file.
  const places = [
    ...Array.from({ length: spec.columns.fixed }, (_, index) => index),
    ...(rawColumns === undefined || rawColumns === ''
      ? optionalKeys.map((key) => spec.columns.optional[key] as number)
      : chosen.value.map((key) => spec.columns.optional[key] as number)),
  ];
  const pick = <T>(row: readonly T[]): readonly T[] => places.map((place) => row[place] as T);

  const groups = async function* (rows: AsyncIterable<readonly (readonly Cell[])[]>) {
    for await (const group of rows) yield group.map(pick);
  };
  const day = Temporal.Instant.from(clock.now().toString()).toString().slice(0, 10);
  const file = (source: AsyncIterable<readonly (readonly Cell[])[]>): OrdersExportOutput =>
    buildExportFile({
      format: format.value,
      baseName: spec.name,
      sheetName: spec.name,
      day,
      groups: groups(source),
      sheetWriter,
    });

  if (rawIds !== undefined) {
    // The selected rows: each id is read through the same list (its rules and its population), so
    // an id the list does not show refuses the whole request, before any byte of the file.
    if (typeof rawIds !== 'string' || rawIds === '') {
      return err({ code: 'validation.failed', fields: [{ path: 'ids', code: 'type' }] });
    }
    const ids = parseExportIds(rawIds, ORDERS_EXPORT_MAX_IDS, (part) =>
      /^[0-9a-f-]{36}$/i.test(part) ? part.toLowerCase() : null,
    );
    if (!ids.ok) return err(ids.error);
    const selected = new Map<string, readonly Cell[]>();
    for (const id of ids.value) {
      const read = await spec.read({ q: id, limit: 2 });
      if (!read.ok) return err(read.error as OrdersExportFailure);
      if (read.value.rows.length === 0) return err({ code: spec.notFound });
      for (const row of read.value.rows) selected.set(String(row[0]), row);
    }
    return ok(
      file(
        (async function* () {
          await Promise.resolve();
          yield [spec.header];
          yield [...selected.values()];
        })(),
      ),
    );
  }

  const first = await spec.read({ ...filter, page: 1, pageSize: 1 });
  if (!first.ok) return err(first.error as OrdersExportFailure);
  const total = first.value.total ?? 0;
  if (total > LIST_EXPORT_MAX_ROWS) {
    return err({ code: 'batch.too-large', max: LIST_EXPORT_MAX_ROWS, matching: total });
  }
  return ok(
    file(
      (async function* () {
        yield [spec.header];
        let cursor: string | null = null;
        do {
          const page = await spec.read({
            ...filter,
            limit: EXPORT_PAGE,
            ...(cursor === null ? {} : { cursor }),
          });
          if (!page.ok) throw new Error(`${spec.name}: the read failed (${page.error.code})`);
          yield page.value.rows;
          cursor = page.value.nextCursor;
        } while (cursor !== null);
      })(),
    ),
  );
}
