import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Money, Result } from '@mondapac/shared-kernel';
import {
  buildExportFile,
  checkExportSize,
  parseExportFormat,
  parseExportIds,
  type ExportCell,
  type ExportFile,
  type SheetWriter,
} from '../../../platform/list-export';
import { ORDERING_ORDER_VIEW } from '../contracts/permissions';
import { decimalOf } from './orders-csv';
import type { MarketZones } from './ports/ship-to-retention.repository';
import type { OrderLabels } from './ports/order-labels';
import type { ListScope, ReadFailure } from './read-flow';

// The export of the admin Sales lists (Shipments, Refunds, Invoices; super list rule 14, Reza's
// spec 0.8): the selected rows (`ids`) or every row of the list's own filter, as CSV or XLSX, with
// the fixed columns and the chosen ones. It reads through the list flow itself, a page at a time,
// so the population, the Market, the filter rules and the customer-key rule are the list's: a row
// carries a customer name and email only when the admin holds `identity.customer-account.view`,
// and the cells are empty otherwise.

/** Rows read per page while the file streams (the list's own page cap). */
export const SALES_EXPORT_PAGE = 100;
/** Selected rows one export may name; a larger selection is "all matching" instead. */
export const SALES_EXPORT_MAX_IDS = 200;

/** The keys of the export itself, beside the list's filter keys. */
const OWN_KEYS = new Set(['format', 'columns', 'ids', 'zone']);

/** What the cells of one row may read beside the row: the zone its times are written in. */
export interface CellContext {
  readonly zone: string;
}

/** One column the admin may pick (or a fixed one): its headers and its cells, the same count. */
export interface ExportColumnSpec<Row> {
  readonly key: string;
  readonly fixed: boolean;
  readonly headers: readonly string[];
  readonly cells: (row: Row, at: CellContext) => readonly ExportCell[];
}

/** One page of the list as the export reads it. */
export interface SalesExportPage<Row> {
  readonly rows: readonly Row[];
  readonly total: number | null;
  readonly nextCursor: string | null;
  /** The name search matched more parties than it could use: the file would miss rows. */
  readonly searchCapped: boolean;
}

export interface SalesListExportSpec<Row> {
  /** The file name without the day, for example `shipments`. */
  readonly name: string;
  readonly sheetName: string;
  /** The list's own filter keys (no paging or sort keys: the file is newest first). */
  readonly filterKeys: ReadonlySet<string>;
  /** Every column in the full file's order; the fixed ones are always written. */
  readonly columns: readonly ExportColumnSpec<Row>[];
  /** Column keys accepted but skipped for this filter (a column of the other Invoices tab). */
  readonly skipped?: ReadonlySet<string>;
  /** One page of the list: `query` is the filter plus paging; `scope` the selection and counts. */
  readonly read: (
    query: Readonly<Record<string, unknown>>,
    scope: ListScope,
  ) => Promise<Result<SalesExportPage<Row>, ReadFailure>>;
  /** True once the customer lookup failed: the file stops rather than leave its cells blank. */
  readonly lookupFailed: () => boolean;
}

export type SalesExportFailure =
  | ReadFailure
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

export interface SalesExportDependencies {
  readonly clock: Clock;
  readonly sheetWriter: SheetWriter;
  readonly zones: MarketZones;
}

/**
 * The names an export reads, for one file: the two name searches are answered once per term (the
 * file is one consistent set of parties, and a 10,000-row file does not search 100 times), and a
 * failed customer lookup is remembered. The list itself treats such a failure as
 * advisory (blank names); a file must not, because a blank customer cell would read as "the admin
 * may not see customers". An admin without the customer key is not a failure: the adapter answers
 * an empty map.
 */
export function exportLabels(labels: OrderLabels): {
  readonly labels: OrderLabels;
  readonly failed: () => boolean;
} {
  let failed = false;
  const remember = <T>(answer: Promise<T>): Promise<T> =>
    answer.catch((error: unknown) => {
      failed = true;
      throw error;
    });
  const customers = new Map<string, ReturnType<OrderLabels['customerAccountsMatching']>>();
  const stores = new Map<string, ReturnType<OrderLabels['sellersMatching']>>();
  const once = <T>(cache: Map<string, T>, term: string, ask: () => T): T => {
    const known = cache.get(term);
    if (known !== undefined) return known;
    const asked = ask();
    cache.set(term, asked);
    return asked;
  };
  const wrapped: OrderLabels = {
    unitLabelsOf: (context, keys) => labels.unitLabelsOf(context, keys),
    // A missing store name still leaves the Seller ID cell: advisory, as on the page.
    storeNamesOf: (context, ids) => labels.storeNamesOf(context, ids),
    customersOf: (context, ids) => remember(labels.customersOf(context, ids)),
    customerAccountsMatching: (context, term) =>
      once(customers, term, () => labels.customerAccountsMatching(context, term)),
    sellersMatching: (context, term) =>
      once(stores, term, () => labels.sellersMatching(context, term)),
    customerShortNamesOf: (context, ids) => labels.customerShortNamesOf(context, ids),
    staffNamesOf: (context, ids) => labels.staffNamesOf(context, ids),
  };
  return { labels: wrapped, failed: () => failed };
}

/** The rule of every Sales list export: the list's own, `permissions [ordering.order.view]`. */
export const SALES_EXPORT_RULE = { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] } as const;

/** The page of a list as the export reads it. */
export const pageOf = <Row>(page: {
  readonly rows: readonly Row[];
  readonly total: number | null;
  readonly nextCursor: string | null;
  readonly searchCapped: boolean;
}) => ({
  rows: page.rows,
  total: page.total,
  nextCursor: page.nextCursor,
  searchCapped: page.searchCapped,
});

const invalid = (path: string, code: string) =>
  err({ code: 'validation.failed', fields: [{ path, code }] } as const);

/** An instant in the list's zone, ISO 8601 with its offset ("2026-11-16T09:30:00+10:00"). */
export function zonedText(instant: Temporal.Instant | null, zone: string): string {
  if (instant === null) return '';
  return instant
    .toZonedDateTimeISO(zone)
    .toString({ timeZoneName: 'never', smallestUnit: 'second' });
}

/** A money value as two cells: the amount in major units as a plain decimal, then its currency. */
export const moneyCells = (money: Money | null): readonly ExportCell[] =>
  money === null ? ['', ''] : [decimalOf(money), money.currency];

/** The headers of a money column: "{Column}" and "{Column} currency". */
export const moneyHeaders = (label: string): readonly string[] => [label, `${label} currency`];

function parseZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  try {
    // Any instant names the zone; epoch keeps the wall clock out of it.
    return Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value).timeZoneId;
  } catch {
    return null;
  }
}

/** `columns` absent: every column; given (comma-separated, may be empty): the fixed ones first. */
function chooseColumns<Row>(
  value: unknown,
  spec: SalesListExportSpec<Row>,
): Result<readonly ExportColumnSpec<Row>[], ReadFailure> {
  if (value === undefined) {
    return ok(spec.columns.filter((column) => !spec.skipped?.has(column.key)));
  }
  if (typeof value !== 'string') return invalid('columns', 'type');
  const chosen: ExportColumnSpec<Row>[] = spec.columns.filter((column) => column.fixed);
  if (value === '') return ok(chosen);
  const seen = new Set<string>();
  for (const key of value.split(',')) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (spec.skipped?.has(key)) continue;
    const column = spec.columns.find((candidate) => candidate.key === key);
    if (column === undefined) return invalid('columns', 'value');
    if (!column.fixed) chosen.push(column);
  }
  return ok(chosen);
}

/**
 * The export of one Sales list. The query keys are checked (any key that is neither the list's
 * filter nor `format`, `columns`, `ids`, `zone` is refused, paging and sort included), the size is
 * read first with a one-row page of the list (more than 10,000 rows is `batch.too-large` with the
 * total), and the file then streams newest first, {@link SALES_EXPORT_PAGE} rows a page, through
 * the same list. A read that fails while streaming fails the file (the route ends the download),
 * so a short file never looks whole.
 */
export async function salesListExport<Row>(
  deps: SalesExportDependencies,
  context: CallContext,
  input: unknown,
  spec: SalesListExportSpec<Row>,
): Promise<Result<ExportFile, SalesExportFailure>> {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('query', 'type');
  }
  const query = input as Readonly<Record<string, unknown>>;
  const filter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || OWN_KEYS.has(key)) continue;
    if (!spec.filterKeys.has(key)) return invalid(key.slice(0, 64), 'unknown');
    filter[key] = value;
  }
  const format = parseExportFormat(query['format']);
  if (!format.ok) return format;
  const columns = chooseColumns(query['columns'], spec);
  if (!columns.ok) return columns;

  let ids: readonly string[] | null = null;
  if (query['ids'] !== undefined) {
    if (typeof query['ids'] !== 'string' || query['ids'] === '') return invalid('ids', 'type');
    const parsed = parseExportIds(query['ids'], SALES_EXPORT_MAX_IDS, (part) => {
      const id = parseId(part.toLowerCase());
      return id.ok ? id.value : null;
    });
    if (!parsed.ok) return parsed;
    ids = parsed.value;
  }

  let zone: string;
  if (query['zone'] !== undefined) {
    const given = parseZone(query['zone']);
    if (given === null) return invalid('zone', 'value');
    zone = given;
  } else {
    try {
      zone = deps.zones.zoneOf(context.market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }

  const scope = { ids };
  const first = await spec.read({ ...filter, page: 1, pageSize: 1 }, scope);
  if (!first.ok) return first;
  // A capped name search would leave matching rows out of the file: the admin narrows it.
  if (first.value.searchCapped) return invalid('search', 'too-broad');
  if (spec.lookupFailed()) return err({ code: 'access.unavailable' });
  const total = first.value.total ?? 0;
  const size = checkExportSize(total, total);
  if (!size.ok) return size;

  const chosen = columns.value;
  const at: CellContext = { zone };
  const header = chosen.flatMap((column) => column.headers);
  const groups = (async function* () {
    yield [header];
    let cursor: string | null = null;
    do {
      const page = await spec.read(
        { ...filter, limit: SALES_EXPORT_PAGE, ...(cursor === null ? {} : { cursor }) },
        { ...scope, skipCounts: true },
      );
      if (!page.ok) throw new Error(`${spec.name}: the read failed (${page.error.code})`);
      if (spec.lookupFailed()) throw new Error(`${spec.name}: a name lookup failed`);
      yield page.value.rows.map((row) => chosen.flatMap((column) => column.cells(row, at)));
      cursor = page.value.nextCursor;
    } while (cursor !== null);
  })();
  const day = deps.clock.now().toZonedDateTimeISO(zone).toPlainDate().toString();
  return ok(
    buildExportFile({
      format: format.value,
      baseName: spec.name,
      sheetName: spec.sheetName,
      day,
      groups,
      sheetWriter: deps.sheetWriter,
    }),
  );
}
