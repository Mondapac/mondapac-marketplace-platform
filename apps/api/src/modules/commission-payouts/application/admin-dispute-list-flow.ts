import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
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
  MAX_PAGED_ROWS,
  rowActions,
  type PermissionProbe,
  type RowActionRule,
} from '../../../platform/list-query';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { COMMISSION_PAYOUTS_DISPUTE_ATTRIBUTE } from '../contracts/permissions';
import {
  DISPUTE_EXPORT_COLUMNS,
  DISPUTE_LIST_VIEWS,
  DISPUTE_MONEY_STATES,
  DISPUTE_SORT_KEYS,
  disputeViewCounts,
  type DisputeBucketCounts,
  type DisputeExportColumn,
  type DisputeListCursor,
  type DisputeListFilter,
  type DisputeListView,
  type DisputeRowAction,
  type DisputeSort,
} from '../domain/admin-dispute-list';
import {
  DISPUTE_STATUSES,
  moneyStateOf,
  type DisputeBucket,
  type DisputeCase,
  type DisputeMoneyState,
  type DisputeStatus,
} from '../domain/dispute';
import { decimalOf } from './admin-payout-list-flow';
import type { DisputeFailure as BaseDisputeFailure, DisputeRowView } from './dispute-flow';
import type { AdminDisputeListReader } from './ports/admin-dispute-list.reader';
import type { DisputeRepository, SellerOrderRef } from './ports/dispute.repository';
import type { SellerNames } from './ports/seller-names';
import type { StoreNameSearch } from './ports/store-name-search';

// The admin Disputes list (super list phase 4, list 23) and its export. A read: nothing here moves
// money or changes a case. The row actions only name what the caller may open; the decision's own
// use case checks its key, the case's state and the step-up again when it runs. Stripe's dispute
// id never leaves this list: it is on the case page only (the Dashboard link).

const logger = new Logger('AdminDisputeList');

/** The dispute refusals, and the store search that could not be read. */
export type DisputeListFailure =
  BaseDisputeFailure | { readonly code: 'commission-payouts.search-unavailable' };

export interface AdminDisputeListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly list: AdminDisputeListReader;
  /** The seller orders of the cases on a page (the ledger's own rows). */
  readonly disputes: Pick<DisputeRepository, 'sellerOrdersOfOrders'>;
  readonly sellerNames: SellerNames;
  readonly storeSearch: StoreNameSearch;
  /** One probe per key of {@link DISPUTE_ROW_RULES}: the gate says which ones the caller holds. */
  readonly probes: Readonly<Record<(typeof DISPUTE_ROW_KEYS)[number], PermissionProbe>>;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export const DISPUTE_ROW_KEYS = [COMMISSION_PAYOUTS_DISPUTE_ATTRIBUTE.key] as const;

/**
 * The row Actions menu of a case: Open, and Decide… on a case that waits for a decision. Deciding
 * is a money action of level 3: the panel opens the case page, where the decision asks for the
 * step-up, and the use case checks the key and each seller order again.
 */
export const DISPUTE_ROW_RULES: readonly RowActionRule<{ readonly bucket: DisputeBucket }>[] = [
  { id: 'open', permission: null },
  {
    id: 'decide',
    permission: COMMISSION_PAYOUTS_DISPUTE_ATTRIBUTE.key,
    when: (row) => row.bucket === 'decision-needed',
  },
];

export const DISPUTE_LIST_DEFAULT_PAGE_SIZE = 25;
/** The Previous/Next page of the older panel: 50 rows unless `limit` says otherwise. */
export const DISPUTE_LIST_DEFAULT_LIMIT = 50;
export const DISPUTE_LIST_MAX_PAGE_SIZE = 100;
export const DISPUTE_SEARCH_MIN = 2;
export const DISPUTE_SEARCH_MAX = 80;
/** Chosen rows one export may name: the same cap as the selection of a page. */
export const DISPUTE_EXPORT_MAX_IDS = 200;
/**
 * The most disputed orders a seller filter or store search may match: the ids go into the
 * query as bind parameters, so a wider match is refused as too broad instead of failing.
 */
export const DISPUTE_SELLER_ORDERS_MAX = 5000;
/** Cases read per chunk while an export streams. */
const EXPORT_CHUNK = 500;

/** The query of the list; every field is optional and checked here. */
export interface DisputeListInput {
  /** A view (tab): all (default) or one bucket. */
  readonly view?: unknown;
  /** The older panel's name of the view (one bucket); never with `view`. */
  readonly filter?: unknown;
  /** Stripe's status of the dispute. */
  readonly status?: unknown;
  /** withdrawn, inquiry, reinstated or none. */
  readonly money?: unknown;
  /** A dispute id or an order id, exact. */
  readonly q?: unknown;
  /** A part of the store name, 2 to 80 characters. */
  readonly search?: unknown;
  readonly sellerId?: unknown;
  /** ISO instants on the opening: at or after `from`, before `to`. */
  readonly from?: unknown;
  readonly to?: unknown;
  /** An ISO instant: the evidence is due before it. */
  readonly dueBefore?: unknown;
  /** The disputed amount in minor units, a string of digits; both ends included. */
  readonly minAmount?: unknown;
  readonly maxAmount?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  /** Page numbers (List paging `pages`): page from 1, page x pageSize at most 10,000. */
  readonly page?: unknown;
  readonly pageSize?: unknown;
  /**
   * Previous/Next (List paging `prev-next`): asked for by `cursor` or `limit`, newest opened
   * first only, so no `page`, `pageSize`, `sort` or `direction` with it.
   */
  readonly cursor?: unknown;
  readonly limit?: unknown;
}

export interface AdminDisputeRow extends DisputeRowView {
  readonly updatedAt: Temporal.Instant;
  readonly actions: readonly DisputeRowAction[];
}

export interface AdminDisputeListPage {
  readonly disputes: readonly AdminDisputeRow[];
  /** The count of each view for the Market, whatever the filter. */
  readonly counts: Readonly<Record<DisputeListView, number>>;
  /** Page numbers: the total, the page and its size. Previous/Next: total and page are null. */
  readonly total: number | null;
  readonly page: number | null;
  readonly pageSize: number;
  readonly nextCursor: string | null;
  /** The store search matched more sellers than sellers answers: narrow it. */
  readonly searchCapped: boolean;
}

const AMOUNT = /^[0-9]{1,15}$/;

/** A cursor is `<opened-at ms>.<dispute id>`, the cursor the older panel already holds. */
export const encodeDisputeListCursor = (row: DisputeListCursor): string =>
  `${row.openedAt.epochMilliseconds}.${row.disputeId}`;

function decodeCursor(value: unknown): DisputeListCursor | null {
  const match = typeof value === 'string' ? /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value) : null;
  const id = match === null ? null : parseId<'Dispute'>(match[2]!);
  if (match === null || id === null || !id.ok) return null;
  return {
    openedAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])),
    disputeId: id.value,
  };
}

type Paging =
  | { readonly kind: 'pages'; readonly page: number; readonly pageSize: number }
  | {
      readonly kind: 'prev-next';
      readonly after: DisputeListCursor | null;
      readonly limit: number;
    };

interface Selector {
  /** The filter without the seller part; `orderIds` is resolved in the read unit. */
  readonly filter: DisputeListFilter;
  readonly sellerId: Id<'Seller'> | null;
  readonly search: string | null;
}

type Fields = { path: string; code: string }[];

/** The selector keys (view, search, filters) shared by the list and the export. */
function parseSelector(input: DisputeListInput, fields: Fields): Selector {
  const oneOf = <T extends string>(path: string, value: unknown, list: readonly T[]): T | null => {
    if (value === undefined || value === '') return null;
    if (list.includes(value as T)) return value as T;
    fields.push({ path, code: 'value' });
    return null;
  };
  if (input.view !== undefined && input.filter !== undefined) {
    fields.push({ path: 'filter', code: 'with-view' });
  }
  const view =
    oneOf('view', input.view, DISPUTE_LIST_VIEWS) ??
    oneOf('filter', input.filter, DISPUTE_LIST_VIEWS) ??
    'all';
  const status = oneOf<DisputeStatus>('status', input.status, DISPUTE_STATUSES);
  const moneyState = oneOf<DisputeMoneyState>('money', input.money, DISPUTE_MONEY_STATES);
  const id = <K extends string>(path: string, value: unknown): Id<K> | null => {
    if (value === undefined || value === '') return null;
    const parsed = typeof value === 'string' ? parseId<K>(value.trim().toLowerCase()) : null;
    if (parsed !== null && parsed.ok) return parsed.value;
    fields.push({ path, code: 'format' });
    return null;
  };
  // Matched, never echoed or logged.
  const caseOrOrderId = id<'Dispute'>('q', input.q);
  const sellerId = id<'Seller'>('sellerId', input.sellerId);
  let search: string | null = null;
  if (input.search !== undefined && input.search !== '') {
    const text = typeof input.search === 'string' ? input.search.trim() : null;
    const length = text === null ? 0 : [...text].length;
    if (text !== null && length >= DISPUTE_SEARCH_MIN && length <= DISPUTE_SEARCH_MAX) {
      search = text;
    } else fields.push({ path: 'search', code: 'length' });
  }
  const instant = (path: 'from' | 'to' | 'dueBefore', value: unknown): Temporal.Instant | null => {
    if (value === undefined || value === '') return null;
    try {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
        return Temporal.Instant.from(value);
      }
    } catch {
      // falls through to the refusal below
    }
    fields.push({ path, code: 'format' });
    return null;
  };
  const from = instant('from', input.from);
  const to = instant('to', input.to);
  if (from !== null && to !== null && Temporal.Instant.compare(from, to) >= 0) {
    fields.push({ path: 'to', code: 'range' });
  }
  const dueBefore = instant('dueBefore', input.dueBefore);
  const amount = (path: 'minAmount' | 'maxAmount', value: unknown): bigint | null => {
    if (value === undefined || value === '') return null;
    if (typeof value === 'string' && AMOUNT.test(value)) return BigInt(value);
    fields.push({ path, code: 'format' });
    return null;
  };
  const minAmount = amount('minAmount', input.minAmount);
  const maxAmount = amount('maxAmount', input.maxAmount);
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    fields.push({ path: 'maxAmount', code: 'range' });
  }
  return {
    filter: {
      bucket: view === 'all' ? null : view,
      status,
      moneyState,
      caseOrOrderId,
      from,
      to,
      dueBefore,
      minAmount,
      maxAmount,
      orderIds: null,
    },
    sellerId,
    search,
  };
}

const whole = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null;

function parseSort(input: DisputeListInput, fields: Fields): DisputeSort {
  let key: DisputeSort['key'] = 'opened';
  if (input.sort !== undefined) {
    if ((DISPUTE_SORT_KEYS as readonly unknown[]).includes(input.sort)) {
      key = input.sort as DisputeSort['key'];
    } else fields.push({ path: 'sort', code: 'value' });
  }
  let direction: DisputeSort['direction'] = 'desc';
  if (input.direction !== undefined) {
    if (input.direction === 'asc' || input.direction === 'desc') direction = input.direction;
    else fields.push({ path: 'direction', code: 'value' });
  }
  return { key, direction };
}

function parse(
  input: DisputeListInput,
): Result<Selector & { readonly sort: DisputeSort; readonly paging: Paging }, DisputeListFailure> {
  const fields: Fields = [];
  const selector = parseSelector(input, fields);
  const prevNext = input.cursor !== undefined || input.limit !== undefined;
  let paging: Paging;
  let sort: DisputeSort = { key: 'opened', direction: 'desc' };
  if (prevNext) {
    for (const path of ['page', 'pageSize', 'sort', 'direction'] as const) {
      if (input[path] !== undefined) fields.push({ path, code: 'with-cursor' });
    }
    let limit = DISPUTE_LIST_DEFAULT_LIMIT;
    if (input.limit !== undefined) {
      const given = whole(input.limit, 1, DISPUTE_LIST_MAX_PAGE_SIZE);
      if (given === null) fields.push({ path: 'limit', code: 'range' });
      else limit = given;
    }
    let after: DisputeListCursor | null = null;
    if (input.cursor !== undefined) {
      after = decodeCursor(input.cursor);
      if (after === null) fields.push({ path: 'cursor', code: 'format' });
    }
    paging = { kind: 'prev-next', after, limit };
  } else {
    let page = 1;
    if (input.page !== undefined) {
      const given = whole(input.page, 1, MAX_PAGED_ROWS);
      if (given === null) fields.push({ path: 'page', code: 'range' });
      else page = given;
    }
    let pageSize = DISPUTE_LIST_DEFAULT_PAGE_SIZE;
    if (input.pageSize !== undefined) {
      const given = whole(input.pageSize, 1, DISPUTE_LIST_MAX_PAGE_SIZE);
      if (given === null) fields.push({ path: 'pageSize', code: 'range' });
      else pageSize = given;
    }
    sort = parseSort(input, fields);
    if (fields.length === 0 && page * pageSize > MAX_PAGED_ROWS) {
      fields.push({ path: 'page', code: 'too-deep' });
    }
    paging = { kind: 'pages', page, pageSize };
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok({ ...selector, sort, paging });
}

const isAdmin = (context: CallContext) =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin';

/**
 * The sellers of the seller filter and the store search, before the read unit: null when neither
 * is given. The store search fails closed (a failed lookup refuses the request instead of listing
 * every case); the term is never logged. Both given: the sellers in both.
 */
async function resolveSellers(
  deps: AdminDisputeListDependencies,
  context: CallContext,
  selector: Selector,
): Promise<
  Result<{ sellerIds: readonly Id<'Seller'>[] | null; capped: boolean }, DisputeListFailure>
> {
  if (selector.search === null) {
    return ok({
      sellerIds: selector.sellerId === null ? null : [selector.sellerId],
      capped: false,
    });
  }
  try {
    const found = await deps.storeSearch.storesMatching(context, selector.search);
    const sellerIds =
      selector.sellerId === null
        ? found.sellerIds
        : found.sellerIds.filter((id) => id === selector.sellerId);
    return ok({ sellerIds, capped: found.capped });
  } catch {
    logger.warn({
      msg: 'commission-payouts.admin-dispute-search.lookup-failed',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'commission-payouts.search-unavailable' });
  }
}

/**
 * The filter with the seller part as the Market's disputed orders of those sellers. More than
 * DISPUTE_SELLER_ORDERS_MAX of them is refused as too broad (on `search` when a search was given).
 */
async function withOrders(
  deps: AdminDisputeListDependencies,
  context: CallContext,
  filter: DisputeListFilter,
  sellerIds: readonly Id<'Seller'>[] | null,
  searched: boolean,
): Promise<Result<DisputeListFilter, DisputeListFailure>> {
  if (sellerIds === null) return ok(filter);
  const orderIds = await deps.list.disputedOrdersOfSellers(
    context.market,
    sellerIds,
    DISPUTE_SELLER_ORDERS_MAX + 1,
  );
  if (orderIds.length > DISPUTE_SELLER_ORDERS_MAX) {
    return err({
      code: 'validation.failed',
      fields: [{ path: searched ? 'search' : 'sellerId', code: 'too-broad' }],
    });
  }
  return ok({ ...filter, orderIds });
}

async function storeNamesOf(
  deps: AdminDisputeListDependencies,
  context: CallContext,
  refs: readonly SellerOrderRef[],
): Promise<ReadonlyMap<Id<'Seller'>, string | null>> {
  const ids = [...new Set(refs.map((ref) => ref.sellerId))];
  if (ids.length === 0) return new Map();
  try {
    const names = await deps.sellerNames.storeNames(context, ids);
    // A name that cannot be read degrades to the id; the case is shown all the same.
    return names === 'unavailable' ? new Map() : names;
  } catch {
    return new Map();
  }
}

/** The sellers of each order, in the order the ledger answers, each once. */
function sellersByOrder(refs: readonly SellerOrderRef[]): ReadonlyMap<string, Id<'Seller'>[]> {
  const map = new Map<string, Id<'Seller'>[]>();
  for (const ref of refs) {
    const list = map.get(ref.orderId) ?? [];
    if (!list.includes(ref.sellerId)) list.push(ref.sellerId);
    map.set(ref.orderId, list);
  }
  return map;
}

const rowOf = (
  c: DisputeCase,
  sellers: readonly Id<'Seller'>[],
  names: ReadonlyMap<Id<'Seller'>, string | null>,
): DisputeRowView & { readonly updatedAt: Temporal.Instant } => ({
  disputeId: c.disputeId,
  orderId: c.orderId,
  sellers: sellers.map((sellerId) => ({ sellerId, storeName: names.get(sellerId) ?? null })),
  reason: c.reason,
  moneyState: moneyStateOf(c),
  status: c.status,
  bucket: c.bucket,
  evidenceDueBy: c.evidenceDueBy,
  amount: { amountMinor: c.amount.amount, currency: c.amount.currency },
  openedAt: c.openedAt,
  updatedAt: c.updatedAt,
});

/**
 * The total of a filter that is only a view, read from the bucket counts; null when the filter
 * narrows further and must be counted.
 */
export function bucketTotal(filter: DisputeListFilter, counts: DisputeBucketCounts): number | null {
  const { bucket, ...rest } = filter;
  if (Object.values(rest).some((value) => value !== null)) return null;
  return bucket === null ? disputeViewCounts(counts).all : counts[bucket];
}

/**
 * The Market's dispute cases for the admin Disputes list: one page with its total (page numbers)
 * or its next cursor (Previous/Next), the view counts, the sellers of each case with their store
 * names (advisory) and each row's actions.
 */
export async function listAdminDisputes(
  deps: AdminDisputeListDependencies,
  context: CallContext,
  input: DisputeListInput,
): Promise<Result<AdminDisputeListPage, DisputeListFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const parsed = parse(input ?? {});
  if (!parsed.ok) return parsed;
  const { sort, paging } = parsed.value;
  const sellers = await resolveSellers(deps, context, parsed.value);
  if (!sellers.ok) return sellers;

  const read = await deps.unitOfWork.run<
    {
      readonly cases: readonly DisputeCase[];
      readonly total: number | null;
      readonly nextCursor: string | null;
      readonly counts: DisputeBucketCounts;
      readonly refs: readonly SellerOrderRef[];
    },
    DisputeListFailure
  >(
    context.market,
    async () => {
      const withSellers = await withOrders(
        deps,
        context,
        parsed.value.filter,
        sellers.value.sellerIds,
        parsed.value.search !== null,
      );
      if (!withSellers.ok) return withSellers;
      const filter = withSellers.value;
      const counts = await deps.list.countByBucket(context.market);
      let cases: readonly DisputeCase[];
      let total: number | null = null;
      let nextCursor: string | null = null;
      if (paging.kind === 'prev-next') {
        // One row more than asked tells whether a next page exists.
        const rows = await deps.list.page(
          context.market,
          filter,
          sort,
          0,
          paging.limit + 1,
          paging.after,
        );
        cases = rows.slice(0, paging.limit);
        const last = cases[cases.length - 1];
        if (rows.length > paging.limit && last !== undefined) {
          nextCursor = encodeDisputeListCursor(last);
        }
      } else {
        cases = await deps.list.page(
          context.market,
          filter,
          sort,
          (paging.page - 1) * paging.pageSize,
          paging.pageSize,
        );
        total = bucketTotal(filter, counts) ?? (await deps.list.count(context.market, filter));
      }
      const refs = await deps.disputes.sellerOrdersOfOrders(
        context.market,
        cases.map((c) => c.orderId),
      );
      return ok({ cases, total, nextCursor, counts, refs });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const { cases, refs } = read.value;
  const [names, granted] = await Promise.all([
    storeNamesOf(deps, context, refs),
    cases.length === 0 ? Promise.resolve(new Set<string>()) : heldKeys(context, deps.probes),
  ]);
  const byOrder = sellersByOrder(refs);
  return ok({
    disputes: cases.map((c) => ({
      ...rowOf(c, byOrder.get(c.orderId) ?? [], names),
      actions: rowActions(c, DISPUTE_ROW_RULES, granted) as DisputeRowAction[],
    })),
    counts: disputeViewCounts(read.value.counts),
    total: read.value.total,
    page: paging.kind === 'pages' ? paging.page : null,
    pageSize: paging.kind === 'pages' ? paging.pageSize : paging.limit,
    nextCursor: read.value.nextCursor,
    searchCapped: sellers.value.capped,
  });
}

// --- the export --------------------------------------------------------------------------------

export interface DisputeExportInput extends DisputeListInput {
  readonly format?: unknown;
  /** Comma-separated optional columns, in the order the page shows them. */
  readonly columns?: unknown;
  /** Comma-separated dispute ids (chosen rows); without it the selector keys pick the cases. */
  readonly ids?: unknown;
}

export type DisputeExportFailure =
  | DisputeListFailure
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number };

const EXPORT_KEYS = new Set([
  'format',
  'columns',
  'ids',
  'view',
  'status',
  'money',
  'q',
  'search',
  'sellerId',
  'from',
  'to',
  'dueBefore',
  'minAmount',
  'maxAmount',
  'sort',
  'direction',
]);

const HEADERS: Readonly<Record<DisputeExportColumn | 'base', readonly string[]>> = {
  base: ['Dispute ID', 'Order ID', 'Sellers', 'Stage', 'Amount', 'Currency', 'Opened (UTC)'],
  reason: ['Reason'],
  'stripe-status': ['Bank status'],
  money: ['Money'],
  'evidence-due': ['Evidence due (UTC)'],
  closed: ['Closed (UTC)'],
  updated: ['Updated (UTC)'],
  'seller-ids': ['Seller IDs'],
};

/** The panel's words (`disputes.filter`, `disputes.money`). */
const BUCKET_LABELS: Readonly<Record<DisputeBucket, string>> = Object.freeze({
  'needs-response': 'Needs response',
  'decision-needed': 'Decision needed',
  'under-review': 'Under review',
  won: 'Won',
  closed: 'Closed',
});
const MONEY_LABELS: Readonly<Record<DisputeMoneyState, string>> = Object.freeze({
  withdrawn: 'Taken by bank',
  inquiry: 'Inquiry only',
  reinstated: 'Returned to us',
  none: 'None',
});

function cellOf(column: DisputeExportColumn, c: DisputeCase, sellers: readonly Id<'Seller'>[]) {
  switch (column) {
    case 'reason':
      return c.reason;
    case 'stripe-status':
      return c.status;
    case 'money':
      return MONEY_LABELS[moneyStateOf(c)];
    case 'evidence-due':
      return c.evidenceDueBy === null ? '' : c.evidenceDueBy.toString();
    case 'closed':
      return c.closedAt === null ? '' : c.closedAt.toString();
    case 'updated':
      return c.updatedAt.toString();
    case 'seller-ids':
      return sellers.join('; ');
  }
}

/**
 * The cases of the list as a CSV or XLSX file: the chosen `ids` (at most 200; an id that is not a
 * case of the Market refuses the whole request as not found) or what the selector keys match, at
 * most 10,000 (more is `batch.too-large` with the total), in the list's sort. The ids are fixed
 * first in one read; the rows then stream in chunks, each with its own read and its store names.
 */
export async function exportAdminDisputes(
  deps: AdminDisputeListDependencies,
  context: CallContext,
  input: DisputeExportInput,
): Promise<Result<ExportFile, DisputeExportFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err({ code: 'validation.failed', fields: [{ path: 'query', code: 'type' }] });
  }
  for (const key of Object.keys(input)) {
    if (!EXPORT_KEYS.has(key)) {
      return err({ code: 'validation.failed', fields: [{ path: key, code: 'unknown' }] });
    }
  }
  const format = parseExportFormat(input.format);
  if (!format.ok) return format;
  const columns = parseExportColumns(input.columns, DISPUTE_EXPORT_COLUMNS);
  if (!columns.ok) return columns;
  const { market } = context;

  let ids: readonly Id<'Dispute'>[];
  if (input.ids !== undefined && input.ids !== '') {
    if (typeof input.ids !== 'string') {
      return err({ code: 'validation.failed', fields: [{ path: 'ids', code: 'type' }] });
    }
    const listed = parseExportIds(input.ids, DISPUTE_EXPORT_MAX_IDS, (part) => {
      const parsed = parseId<'Dispute'>(part.trim().toLowerCase());
      return parsed.ok ? parsed.value : null;
    });
    if (!listed.ok) return listed;
    const wanted = listed.value;
    const found = await deps.unitOfWork.run<readonly DisputeCase[], DisputeListFailure>(
      market,
      async () => ok(await deps.list.byIds(market, wanted)),
      { readOnly: true },
    );
    if (!found.ok) return found;
    const known = new Set<string>(found.value.map((c) => c.disputeId));
    if (wanted.some((id) => !known.has(id))) {
      return err({ code: 'commission-payouts.dispute-not-found' });
    }
    ids = wanted;
  } else {
    const fields: Fields = [];
    const selector = parseSelector(input, fields);
    const sort = parseSort(input, fields);
    if (fields.length > 0) return err({ code: 'validation.failed', fields });
    const sellers = await resolveSellers(deps, context, selector);
    if (!sellers.ok) return sellers;
    // A search that matched more stores than it can carry would export only part of the list.
    if (sellers.value.capped) {
      return err({ code: 'validation.failed', fields: [{ path: 'search', code: 'too-broad' }] });
    }
    const picked = await deps.unitOfWork.run<
      { readonly found: readonly Id<'Dispute'>[]; readonly total: number },
      DisputeListFailure
    >(
      market,
      async () => {
        const withSellers = await withOrders(
          deps,
          context,
          selector.filter,
          sellers.value.sellerIds,
          selector.search !== null,
        );
        if (!withSellers.ok) return withSellers;
        const filter = withSellers.value;
        const found = await deps.list.idsPage(market, filter, sort, LIST_EXPORT_MAX_ROWS + 1);
        if (found.length <= LIST_EXPORT_MAX_ROWS) return ok({ found, total: found.length });
        return ok({ found, total: await deps.list.count(market, filter) });
      },
      { readOnly: true },
    );
    if (!picked.ok) return picked;
    const size = checkExportSize(picked.value.found.length, picked.value.total);
    if (!size.ok) return size;
    ids = picked.value.found;
  }

  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'disputes',
      sheetName: 'Disputes',
      day: deps.clock.now().toString().slice(0, 10),
      groups: exportRows(deps, context, ids, columns.value),
      sheetWriter: deps.sheetWriter,
    }),
  );
}

async function* exportRows(
  deps: AdminDisputeListDependencies,
  context: CallContext,
  ids: readonly Id<'Dispute'>[],
  columns: readonly DisputeExportColumn[],
): AsyncGenerator<readonly (readonly ExportCell[])[]> {
  yield [[...HEADERS.base, ...columns.flatMap((column) => HEADERS[column])]];
  for (let start = 0; start < ids.length; start += EXPORT_CHUNK) {
    const chunk = ids.slice(start, start + EXPORT_CHUNK);
    const read = await deps.unitOfWork.run<
      { readonly cases: readonly DisputeCase[]; readonly refs: readonly SellerOrderRef[] },
      DisputeListFailure
    >(
      context.market,
      async () => {
        const cases = await deps.list.byIds(context.market, chunk);
        const refs = await deps.disputes.sellerOrdersOfOrders(
          context.market,
          cases.map((c) => c.orderId),
        );
        return ok({ cases, refs });
      },
      { readOnly: true },
    );
    if (!read.ok) throw new Error('commission-payouts.admin-disputes-export: the read failed');
    // In the order the ids were fixed (the list's sort), whatever order the read answers.
    const byId = new Map<string, DisputeCase>(read.value.cases.map((c) => [c.disputeId, c]));
    const cases = chunk.flatMap((id) => {
      const found = byId.get(id);
      return found === undefined ? [] : [found];
    });
    const names = await storeNamesOf(deps, context, read.value.refs);
    const byOrder = sellersByOrder(read.value.refs);
    yield cases.map((c) => {
      const sellers = byOrder.get(c.orderId) ?? [];
      return [
        c.disputeId,
        c.orderId,
        sellers.map((id) => names.get(id) ?? `Seller ${id}`).join('; '),
        BUCKET_LABELS[c.bucket],
        decimalOf(c.amount.amount, c.amount.currency),
        c.amount.currency,
        c.openedAt.toString(),
        ...columns.map((column) => cellOf(column, c, sellers)),
      ];
    });
  }
}
