import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  type RefundCursor,
  REFUND_SORT_KEYS,
  refundRowActions,
  type RefundLedgerFilter,
  type RefundListFilter,
  type RefundListPage,
  type RefundListRecord,
  type RefundSort,
} from '../domain/admin-refund-list';
import { LOSS_BEARERS, type LossBearer } from '../domain/reason-codes';
import { REFUND_REASONS, type RefundReason, type RefundState } from '../domain/refund';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { settled } from './order-labels';
import type { AdminRefundListReader } from './ports/admin-refund-list.reader';
import type { OrderLabels } from './ports/order-labels';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_PAGED_ROWS,
  MAX_SEARCH_LENGTH,
  MIN_SEARCH_LENGTH,
  type ListScope,
  type ReadFailure,
} from './read-flow';

const logger = new Logger('AdminRefundList');

export interface AdminRefundListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly refunds: AdminRefundListReader;
  readonly labels: OrderLabels;
}

/** The query of the admin Refunds list; every field is optional and checked here. */
export interface RefundListInput {
  /** The page from 1 (default 1); page x pageSize may not pass 10,000. */
  readonly page?: unknown;
  readonly pageSize?: unknown;
  /**
   * Previous/Next paging (List paging `prev-next`, and past row 10,000): `limit` rows from 1 to
   * 100, after `cursor` (the `nextCursor` of the page before). Newest request first only; no
   * `page`, `pageSize`, `sort` or `direction` with it.
   */
  readonly cursor?: unknown;
  readonly limit?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly state?: unknown;
  /** A refund, order or seller order id, or a Stripe refund id (`re_…`), exact. */
  readonly q?: unknown;
  /** Customer or store name, 2 to 80 characters (same rules as the Orders list). */
  readonly search?: unknown;
  readonly reason?: unknown;
  readonly actor?: unknown;
  readonly lossBearer?: unknown;
  readonly ledger?: unknown;
  readonly sellerId?: unknown;
  /** ISO instants on the request time: at or after `from`, before `to`. */
  readonly from?: unknown;
  readonly to?: unknown;
  /** Gross in minor units, a string of digits; both ends included. */
  readonly minAmount?: unknown;
  readonly maxAmount?: unknown;
}

const STATES: readonly RefundState[] = ['pending', 'succeeded', 'failed'];
const ACTORS = ['admin', 'seller'] as const;
const LEDGER: readonly RefundLedgerFilter[] = ['waiting', 'recorded'];
const STRIPE_REFUND_ID = /^re_[A-Za-z0-9]{1,64}$/;
const AMOUNT = /^[0-9]{1,15}$/;

/** A cursor is `<requested-at ms>.<refund id>`: opaque to callers, checked on the way in. */
export const encodeRefundCursor = (row: RefundCursor): string =>
  `${row.requestedAt.epochMilliseconds}.${row.refundId}`;

function decodeCursor(value: unknown): RefundCursor | null {
  const match = typeof value === 'string' ? /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value) : null;
  const id = match === null ? null : parseId<'Refund'>(match[2]!);
  if (match === null || id === null || !id.ok) return null;
  return {
    requestedAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])),
    refundId: id.value,
  };
}

type Paging =
  | { readonly kind: 'pages'; readonly page: number; readonly pageSize: number }
  | { readonly kind: 'prev-next'; readonly after: RefundCursor | null; readonly limit: number };

interface Parsed {
  readonly filter: RefundListFilter;
  readonly search: string | null;
  readonly sort: RefundSort;
  readonly paging: Paging;
}

function parse(input: RefundListInput): Result<Parsed, ReadFailure> {
  const fields: { path: string; code: string }[] = [];
  const whole = (value: unknown, min: number, max: number): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
      ? value
      : null;
  const oneOf = <T extends string>(path: string, value: unknown, list: readonly T[]): T | null => {
    if (value === undefined) return null;
    if (list.includes(value as T)) return value as T;
    fields.push({ path, code: 'value' });
    return null;
  };

  let page = 1;
  if (input.page !== undefined) {
    const given = whole(input.page, 1, MAX_PAGED_ROWS);
    if (given === null) fields.push({ path: 'page', code: 'range' });
    else page = given;
  }
  let pageSize = DEFAULT_PAGE_SIZE;
  if (input.pageSize !== undefined) {
    const given = whole(input.pageSize, 1, MAX_PAGE_SIZE);
    if (given === null) fields.push({ path: 'pageSize', code: 'range' });
    else pageSize = given;
  }
  // Previous/Next: asked for by a cursor or a limit; it walks newest request first only.
  const prevNext = input.cursor !== undefined || input.limit !== undefined;
  let after: RefundCursor | null = null;
  let limit = DEFAULT_PAGE_SIZE;
  if (prevNext) {
    for (const path of ['page', 'pageSize', 'sort', 'direction'] as const) {
      if (input[path] !== undefined) fields.push({ path, code: 'with-cursor' });
    }
    if (input.cursor !== undefined) {
      after = decodeCursor(input.cursor);
      if (after === null) fields.push({ path: 'cursor', code: 'format' });
    }
    if (input.limit !== undefined) {
      const given = whole(input.limit, 1, MAX_PAGE_SIZE);
      if (given === null) fields.push({ path: 'limit', code: 'range' });
      else limit = given;
    }
  }
  const key = oneOf('sort', input.sort, REFUND_SORT_KEYS) ?? 'requested';
  const direction = oneOf('direction', input.direction, ['asc', 'desc'] as const) ?? 'desc';
  const state = oneOf('state', input.state, STATES);
  const reason = oneOf<RefundReason>('reason', input.reason, REFUND_REASONS);
  const actor = oneOf('actor', input.actor, ACTORS);
  const lossBearer = oneOf<LossBearer>('lossBearer', input.lossBearer, LOSS_BEARERS);
  const ledger = oneOf('ledger', input.ledger, LEDGER);

  let reference: string | null = null;
  let stripeRefundId: string | null = null;
  if (input.q !== undefined) {
    const text = typeof input.q === 'string' ? input.q.trim() : '';
    const id = parseId(text.toLowerCase());
    // Matched, never echoed or logged.
    if (STRIPE_REFUND_ID.test(text)) stripeRefundId = text;
    else if (id.ok) reference = id.value;
    else fields.push({ path: 'q', code: 'format' });
  }
  let search: string | null = null;
  if (input.search !== undefined) {
    const text = typeof input.search === 'string' ? input.search.trim() : null;
    if (
      text !== null &&
      [...text].length >= MIN_SEARCH_LENGTH &&
      [...text].length <= MAX_SEARCH_LENGTH
    ) {
      search = text;
    } else fields.push({ path: 'search', code: 'length' });
  }
  let sellerId: Id<'Seller'> | null = null;
  if (input.sellerId !== undefined) {
    const parsed = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (parsed !== null && parsed.ok) sellerId = parsed.value;
    else fields.push({ path: 'sellerId', code: 'format' });
  }
  const instant = (path: 'from' | 'to', value: unknown): Temporal.Instant | null => {
    if (value === undefined) return null;
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
  const amount = (path: 'minAmount' | 'maxAmount', value: unknown): bigint | null => {
    if (value === undefined) return null;
    if (typeof value === 'string' && AMOUNT.test(value)) return BigInt(value);
    fields.push({ path, code: 'format' });
    return null;
  };
  const minAmount = amount('minAmount', input.minAmount);
  const maxAmount = amount('maxAmount', input.maxAmount);
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    fields.push({ path: 'maxAmount', code: 'range' });
  }
  if (fields.length === 0 && !prevNext && page * pageSize > MAX_PAGED_ROWS) {
    fields.push({ path: 'page', code: 'too-deep' });
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok({
    filter: {
      ids: null,
      state,
      reference,
      stripeRefundId,
      reason,
      actor,
      lossBearer,
      ledger,
      sellerId,
      from,
      to,
      minAmount,
      maxAmount,
      parties: null,
    },
    search,
    sort: prevNext ? { key: 'requested', direction: 'desc' } : { key, direction },
    paging: prevNext ? { kind: 'prev-next', after, limit } : { kind: 'pages', page, pageSize },
  });
}

/**
 * The Market's refunds for the admin Refunds list: one page with its total and the per-state
 * counts, then the store and customer names (advisory: a failed lookup leaves them null). The
 * search is resolved by the owning modules before the read unit and fails closed, exactly as on
 * the Orders list.
 */
export async function listRefunds(
  deps: AdminRefundListDependencies,
  context: CallContext,
  input: RefundListInput,
  scope: ListScope = {},
): Promise<Result<RefundListPage, ReadFailure>> {
  const parsed = parse(input ?? {});
  if (!parsed.ok) return parsed;
  const { sort, paging } = parsed.value;
  // An export's selected rows narrow the list's own filter (an AND).
  let filter = { ...parsed.value.filter, ids: scope.ids ?? null };
  let searchCapped = false;
  let searchScope: RefundListPage['searchScope'] = null;
  if (parsed.value.search !== null) {
    try {
      const [customers, stores] = await Promise.all([
        deps.labels.customerAccountsMatching(context, parsed.value.search),
        deps.labels.sellersMatching(context, parsed.value.search),
      ]);
      filter = {
        ...filter,
        parties: { accountIds: customers.accountIds, sellerIds: stores.sellerIds },
      };
      searchCapped = customers.capped || stores.capped;
      searchScope = customers.searched ? 'customers-and-stores' : 'stores';
    } catch {
      // Never log the text or the error (it may name the term).
      logger.warn({
        msg: 'ordering.admin-refund-search.lookup-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'ordering.search-unavailable' });
    }
  }
  const read = await deps.unitOfWork.run<
    {
      readonly records: readonly RefundListRecord[];
      readonly total: number | null;
      readonly nextCursor: string | null;
      readonly counts: RefundListPage['counts'];
    },
    ReadFailure
  >(
    context.market,
    async () => {
      if (paging.kind === 'prev-next') {
        // One row more than asked tells whether a next page exists.
        const [rows, counts] = await Promise.all([
          deps.refunds.page(context.market, filter, sort, 0, paging.limit + 1, paging.after),
          scope.skipCounts === true
            ? Promise.resolve({ pending: 0, succeeded: 0, failed: 0 })
            : deps.refunds.countByState(context.market),
        ]);
        const records = rows.slice(0, paging.limit);
        const last = records[records.length - 1];
        const nextCursor =
          rows.length > paging.limit && last !== undefined
            ? encodeRefundCursor({ requestedAt: last.requestedAt, refundId: last.refundId })
            : null;
        return ok({ records, total: null, nextCursor, counts });
      }
      const { page, pageSize } = paging;
      const [records, counts] = await Promise.all([
        deps.refunds.page(context.market, filter, sort, (page - 1) * pageSize, pageSize),
        deps.refunds.countByState(context.market),
      ]);
      // A tab with no other filter has its count already; only a narrower filter counts again.
      const total = tabTotal(filter, counts) ?? (await deps.refunds.count(context.market, filter));
      return ok({ records, total, nextCursor: null, counts });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const { records } = read.value;
  const [storeAnswer, customerAnswer] =
    records.length === 0
      ? [undefined, undefined]
      : await Promise.allSettled([
          deps.labels.storeNamesOf(context, [...new Set(records.map((r) => r.sellerId))]),
          deps.labels.customersOf(context, [...new Set(records.map((r) => r.accountId))]),
        ]);
  const storeNames =
    storeAnswer === undefined ? undefined : settled(context, 'store-names', storeAnswer);
  const customers =
    customerAnswer === undefined ? undefined : settled(context, 'customers', customerAnswer);
  return ok({
    rows: records.map((record) => ({
      ...record,
      storeName: storeNames?.get(record.sellerId) ?? null,
      customer: customers?.get(record.accountId) ?? null,
      actions: refundRowActions(record),
    })),
    counts: read.value.counts,
    total: read.value.total,
    page: paging.kind === 'pages' ? paging.page : null,
    pageSize: paging.kind === 'pages' ? paging.pageSize : paging.limit,
    nextCursor: read.value.nextCursor,
    searchCapped,
    searchScope,
  });
}

/**
 * The total of a filter that is only a tab (a state, or nothing), read from the tab counts; null
 * when the filter narrows further and must be counted.
 */
export function tabTotal(
  filter: RefundListFilter,
  counts: RefundListPage['counts'],
): number | null {
  const { state, ...rest } = filter;
  if (Object.values(rest).some((value) => value !== null)) return null;
  return state === null ? counts.pending + counts.succeeded + counts.failed : counts[state];
}
