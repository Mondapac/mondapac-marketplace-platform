import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Clock, Result } from '@mondapac/shared-kernel';
import { csvChunks, ORDERS_EXPORT_MAX_ROWS, type Cell } from './orders-csv';

/** Orders read per page while the file streams. */
export const EXPORT_PAGE = 100;

export interface OrdersExportOutput {
  readonly filename: string;
  readonly contentType: string;
  /** The file in chunks of text: the header first. */
  readonly chunks: AsyncIterable<string>;
}

export type OrdersExportFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly matching: number };

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
 * count is read first with a one-row page (more than {@link ORDERS_EXPORT_MAX_ROWS} is refused whole
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
  },
): Promise<Result<OrdersExportOutput, OrdersExportFailure>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err({ code: 'validation.failed', fields: [{ path: 'query', code: 'type' }] });
  }
  const filter: Record<string, unknown> = {};
  const unknown: { path: string; code: string }[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (key === 'format') {
      if (value !== 'csv') unknown.push({ path: 'format', code: 'value' });
    } else if (spec.allowed.has(key)) filter[key] = value;
    else unknown.push({ path: key.slice(0, 64), code: 'unknown' });
  }
  if (unknown.length > 0) return err({ code: 'validation.failed', fields: unknown.slice(0, 10) });

  const first = await spec.read({ ...filter, page: 1, pageSize: 1 });
  if (!first.ok) return err(first.error as OrdersExportFailure);
  const total = first.value.total ?? 0;
  if (total > ORDERS_EXPORT_MAX_ROWS) {
    return err({ code: 'batch.too-large', max: ORDERS_EXPORT_MAX_ROWS, matching: total });
  }
  const pages = (async function* () {
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
  })();
  const day = Temporal.Instant.from(clock.now().toString()).toString().slice(0, 10);
  return ok({
    filename: `${spec.name}-${day}.csv`,
    contentType: 'text/csv; charset=utf-8',
    chunks: csvChunks(spec.header, pages),
  });
}
