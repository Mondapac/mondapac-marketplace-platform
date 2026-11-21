import { err, minorUnitExponent, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import {
  buildExportFile,
  checkExportSize,
  LIST_EXPORT_MAX_ROWS,
  parseExportColumns,
  parseExportFormat,
  parseExportIds,
  type ExportCell,
  type ExportFile,
  type SheetWriter,
} from '../../../platform/list-export';
import {
  heldKeys,
  listPage,
  listQueryInvalid,
  pageWindow,
  parseInstantRange,
  parseListQuery,
  rowActions,
  MAX_PAGED_ROWS,
  type ListPage,
  type ListPagingMode,
  type ListQueryFailure,
  type PermissionProbe,
  type RowActionRule,
} from '../../../platform/list-query';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { PRICING_PRICE_HOLD_DECIDE } from '../contracts/permissions';
import {
  EMPTY_HOLD_FILTER,
  HOLD_EXPORT_COLUMNS,
  HOLD_LIST_VIEWS,
  HOLD_SORT_KEYS,
  viewFilter,
  type HoldExportColumn,
  type HoldListFilter,
  type HoldListView,
  type HoldRowAction,
  type HoldSort,
  type HoldViewCounts,
} from '../domain/hold-list';
import { withHoldLabels, type HoldLabelDependencies, type LabelledHold } from './hold-labels';
import type { PendingHoldView, PriceSeriesRepository } from './ports/price-series.repository';

// The admin price-hold list (super list phase 3, list 19) and its export. A read: nothing here
// decides a hold. The row actions only name what the caller may do; the decision's own use case
// checks `pricing.price-hold.decide`, the record's state and the submitter again when it runs.
// Search by product or store name is not offered: names live in catalog and sellers, and a name
// search would have to ask both for every held record. The filters are ids (record, Offer, seller).

export const HOLD_ROW_KEYS = [PRICING_PRICE_HOLD_DECIDE.key] as const;

/** The row Actions menu: Open always; Decide… for a caller who may decide. */
export const HOLD_ROW_RULES: readonly RowActionRule<PendingHoldView>[] = [
  { id: 'open', permission: null },
  { id: 'decide', permission: PRICING_PRICE_HOLD_DECIDE.key },
];

export interface AdminHoldListDependencies extends HoldLabelDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly series: PriceSeriesRepository;
  /** One probe per key of {@link HOLD_ROW_KEYS}. */
  readonly probes: Readonly<Record<(typeof HOLD_ROW_KEYS)[number], PermissionProbe>>;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export const HOLD_LIST_DEFAULT_PAGE_SIZE = 25;
export const HOLD_LIST_MAX_PAGE_SIZE = 100;
export const HOLD_EXPORT_MAX_IDS = 200;
/** Rows read per chunk while an export streams. */
const EXPORT_CHUNK = 500;

/** The selector keys of the list's query (paging and sort aside). */
export const HOLD_SELECTOR_KEYS = [
  'view',
  'kind',
  'change',
  'q',
  'sellerId',
  'from',
  'to',
  'minAmount',
  'maxAmount',
] as const;
const LIST_KEYS = new Set<string>([
  ...HOLD_SELECTOR_KEYS,
  'sort',
  'direction',
  'page',
  'pageSize',
  'paging',
]);
const EXPORT_KEYS = new Set<string>([
  ...HOLD_SELECTOR_KEYS,
  'sort',
  'direction',
  'format',
  'columns',
  'ids',
]);

export type HoldListInput = Readonly<Record<string, unknown>>;

export type HoldListFailure =
  | ListQueryFailure
  | { readonly code: 'pricing.hold.not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

export interface AdminHoldRow extends LabelledHold {
  readonly actions: readonly HoldRowAction[];
}

export interface AdminHoldListPage extends ListPage<AdminHoldRow> {
  /** The count of each view for the Market, whatever the filter. */
  readonly counts: HoldViewCounts;
}

const AMOUNT = /^[0-9]{1,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

export interface HoldSelector {
  readonly filter: HoldListFilter;
}

/**
 * Reads the selector keys of the list (view, kind, change, q, sellerId, from, to, minAmount,
 * maxAmount). The list, its export and its saved filters read them here alone, so a saved filter
 * holds exactly what the list accepts.
 */
export function parseHoldSelector(record: HoldListInput): Result<HoldSelector, ListQueryFailure> {
  let view: HoldListView = 'all';
  if (!absent(record['view'])) {
    const found = HOLD_LIST_VIEWS.find((candidate) => candidate === record['view']);
    if (found === undefined) return listQueryInvalid('view', 'value');
    view = found;
  }
  let { kind, direction } = viewFilter(view);
  if (!absent(record['kind'])) {
    if (record['kind'] !== 'regular' && record['kind'] !== 'special') {
      return listQueryInvalid('kind', 'value');
    }
    kind = record['kind'];
  }
  if (!absent(record['change'])) {
    if (record['change'] !== 'up' && record['change'] !== 'down') {
      return listQueryInvalid('change', 'value');
    }
    direction = record['change'];
  }
  let recordOrOfferId: string | null = null;
  if (!absent(record['q'])) {
    const text = typeof record['q'] === 'string' ? record['q'].trim().toLowerCase() : '';
    if (!UUID.test(text)) return listQueryInvalid('q', 'format');
    recordOrOfferId = text;
  }
  let sellerId: Id<'Seller'> | null = null;
  if (!absent(record['sellerId'])) {
    const parsed =
      typeof record['sellerId'] === 'string' ? parseId<'Seller'>(record['sellerId']) : null;
    if (parsed === null || !parsed.ok) return listQueryInvalid('sellerId', 'format');
    sellerId = parsed.value;
  }
  const range = parseInstantRange(record, '');
  if (!range.ok) return range;
  let minAmount: bigint | null = null;
  let maxAmount: bigint | null = null;
  for (const key of ['minAmount', 'maxAmount'] as const) {
    const value = record[key];
    if (absent(value)) continue;
    if (typeof value !== 'string' || !AMOUNT.test(value)) return listQueryInvalid(key, 'format');
    if (key === 'minAmount') minAmount = BigInt(value);
    else maxAmount = BigInt(value);
  }
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    return listQueryInvalid('maxAmount', 'range');
  }
  return ok({
    filter: {
      ...EMPTY_HOLD_FILTER,
      kind,
      direction,
      sellerId,
      recordOrOfferId,
      from: range.value.from,
      to: range.value.to,
      minAmount,
      maxAmount,
    },
  });
}

function unknownKey(record: HoldListInput, allowed: ReadonlySet<string>): string | null {
  return Object.keys(record).find((key) => !allowed.has(key)) ?? null;
}

/** Page and Previous/Next both read by offset: a page past 10,000 rows is refused. */
const SPEC = {
  sorts: HOLD_SORT_KEYS,
  defaultSort: 'submitted',
  defaultDirection: () => 'asc' as const,
  defaultPageSize: HOLD_LIST_DEFAULT_PAGE_SIZE,
  maxPageSize: HOLD_LIST_MAX_PAGE_SIZE,
  maxPage: MAX_PAGED_ROWS,
} as const;

/**
 * The held records of the Market for the admin list: one page with its total (page numbers) or
 * without (Previous/Next), the view counts, the display names (advisory) and each row's actions.
 * The queue's old order, oldest submission first, stays the default.
 */
export async function listAdminHolds(
  deps: AdminHoldListDependencies,
  context: CallContext,
  input: HoldListInput,
): Promise<Result<AdminHoldListPage, HoldListFailure>> {
  const record = input ?? {};
  const stray = unknownKey(record, LIST_KEYS);
  if (stray !== null) return listQueryInvalid(stray, 'unknown');
  const query = parseListQuery(record, SPEC);
  if (!query.ok) return query;
  if ((query.value.page - 1) * query.value.pageSize >= MAX_PAGED_ROWS) {
    return listQueryInvalid('page', 'range');
  }
  const selector = parseHoldSelector(record);
  if (!selector.ok) return selector;
  const { filter } = selector.value;
  const sort: HoldSort = { key: query.value.sort, direction: query.value.direction };
  const { offset, limit } = pageWindow(query.value);
  const paging: ListPagingMode = query.value.paging;

  const read = await deps.unitOfWork.run<
    {
      readonly rows: readonly PendingHoldView[];
      readonly counts: HoldViewCounts;
      readonly total: number | null;
    },
    never
  >(
    context.market,
    async () => {
      const rows = await deps.series.queryPendingHolds(context.market, filter, sort, offset, limit);
      const counts = await deps.series.pendingHoldViewCounts(context.market);
      const total =
        paging === 'pages'
          ? await deps.series.countPendingHoldsWhere(context.market, filter)
          : null;
      return ok({ rows, counts, total });
    },
    { readOnly: true },
  );
  if (!read.ok) throw new Error('pricing.list-price-holds: the read failed');

  const page = listPage(read.value.rows, query.value, read.value.total);
  const [labelled, granted] = await Promise.all([
    withHoldLabels(deps, context, page.items),
    page.items.length === 0 ? Promise.resolve(new Set<string>()) : heldKeys(context, deps.probes),
  ]);
  const byId = new Map(page.items.map((row) => [row.recordId, row]));
  return ok({
    ...page,
    items: labelled.map((row) => ({
      ...row,
      actions: rowActions(
        byId.get(row.recordId) ?? row,
        HOLD_ROW_RULES,
        granted,
      ) as HoldRowAction[],
    })),
    counts: read.value.counts,
  });
}

// --- the export --------------------------------------------------------------------------------

export interface HoldExportInput {
  readonly [key: string]: unknown;
}

const HEADERS: Readonly<Record<HoldExportColumn | 'base', readonly string[]>> = {
  base: [
    'Product',
    'Variant',
    'Store',
    'Kind',
    'Direction',
    'Held amount',
    'Reference amount',
    'Currency',
    'Submitted (UTC)',
  ],
  'offer-id': ['Offer ID'],
  'variant-id': ['Variant ID'],
  'seller-id': ['Seller ID'],
  'record-id': ['Record ID'],
  window: ['Special starts (UTC)', 'Special ends (UTC)'],
  anchor: ['Reference record ID'],
};

/** Minor units as a decimal amount of the currency (`12345` AUD is `123.45`), exact. */
export function decimalOf(amountMinor: bigint, currency: string): string {
  const digits = minorUnitExponent(currency);
  const text = amountMinor.toString().padStart(digits + 1, '0');
  return digits === 0 ? text : `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

function cellsOf(column: HoldExportColumn, hold: LabelledHold): ExportCell[] {
  switch (column) {
    case 'offer-id':
      return [hold.offerId];
    case 'variant-id':
      return [hold.variantId];
    case 'seller-id':
      return [hold.sellerId];
    case 'record-id':
      return [hold.recordId];
    case 'window':
      return hold.window === null
        ? ['', '']
        : [hold.window.startsAt.toString(), hold.window.endsAt.toString()];
    case 'anchor':
      return [hold.anchorRecordId];
  }
}

/**
 * The held records of the list as a CSV or XLSX file: the chosen `ids` (at most 200; an id that is
 * not a pending record of the Market refuses the whole request as not found) or what the selector
 * keys match, at most 10,000 (more is `batch.too-large` with the total), in the list's sort. The
 * rows are read once and the labels are added in chunks.
 */
export async function exportAdminHolds(
  deps: AdminHoldListDependencies,
  context: CallContext,
  input: HoldExportInput,
): Promise<Result<ExportFile, HoldListFailure>> {
  const record = input ?? {};
  const stray = unknownKey(record, EXPORT_KEYS);
  if (stray !== null) return listQueryInvalid(stray, 'unknown');
  const format = parseExportFormat(record['format']);
  if (!format.ok) return format;
  const columns = parseExportColumns(record['columns'], HOLD_EXPORT_COLUMNS);
  if (!columns.ok) return columns;
  const { market } = context;

  let rows: readonly PendingHoldView[];
  if (!absent(record['ids'])) {
    if (typeof record['ids'] !== 'string') return listQueryInvalid('ids', 'type');
    const listed = parseExportIds(record['ids'], HOLD_EXPORT_MAX_IDS, (part) => {
      const text = part.trim().toLowerCase();
      return UUID.test(text) ? (text as Id<'RegularPriceRecord'>) : null;
    });
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const found = await deps.unitOfWork.run<readonly PendingHoldView[], never>(
      market,
      async () => ok(await deps.series.findPendingHoldsByIds(market, wanted)),
      { readOnly: true },
    );
    if (!found.ok) throw new Error('pricing.export-price-holds: the read failed');
    const known = new Map<string, PendingHoldView>(
      found.value.map((hold) => [hold.recordId, hold]),
    );
    if (wanted.some((id) => !known.has(id))) return err({ code: 'pricing.hold.not-found' });
    rows = wanted.map((id) => known.get(id) as PendingHoldView);
  } else {
    const query = parseListQuery(record, SPEC);
    if (!query.ok) return query;
    const selector = parseHoldSelector(record);
    if (!selector.ok) return selector;
    const { filter } = selector.value;
    const sort: HoldSort = { key: query.value.sort, direction: query.value.direction };
    const picked = await deps.unitOfWork.run<
      { readonly rows: readonly PendingHoldView[]; readonly total: number },
      never
    >(
      market,
      async () => {
        const found = await deps.series.queryPendingHolds(
          market,
          filter,
          sort,
          0,
          LIST_EXPORT_MAX_ROWS + 1,
        );
        const total =
          found.length <= LIST_EXPORT_MAX_ROWS
            ? found.length
            : await deps.series.countPendingHoldsWhere(market, filter);
        return ok({ rows: found, total });
      },
      { readOnly: true },
    );
    if (!picked.ok) throw new Error('pricing.export-price-holds: the read failed');
    const size = checkExportSize(picked.value.rows.length, picked.value.total);
    if (!size.ok) return size;
    rows = picked.value.rows;
  }

  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'price-holds',
      sheetName: 'Price holds',
      day: deps.clock.now().toString().slice(0, 10),
      groups: exportRows(deps, context, rows, columns.value),
      sheetWriter: deps.sheetWriter,
    }),
  );
}

async function* exportRows(
  deps: AdminHoldListDependencies,
  context: CallContext,
  rows: readonly PendingHoldView[],
  columns: readonly HoldExportColumn[],
): AsyncGenerator<readonly (readonly ExportCell[])[]> {
  yield [[...HEADERS.base, ...columns.flatMap((column) => HEADERS[column])]];
  for (let start = 0; start < rows.length; start += EXPORT_CHUNK) {
    const labelled = await withHoldLabels(deps, context, rows.slice(start, start + EXPORT_CHUNK));
    yield labelled.map((hold) => [
      hold.productName ?? '',
      hold.variantLabel ?? '',
      hold.storeName ?? `Seller ${hold.sellerId}`,
      hold.kind === 'special' ? 'Special' : 'Regular',
      hold.direction === 'up' ? 'Increase' : 'Decrease',
      decimalOf(hold.amount.amount, hold.amount.currency),
      decimalOf(hold.anchorAmount.amount, hold.anchorAmount.currency),
      hold.amount.currency,
      hold.submittedAt.toString(),
      ...columns.flatMap((column) => cellsOf(column, hold)),
    ]);
  }
}
