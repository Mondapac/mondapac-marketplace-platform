import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
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

interface Parsed {
  readonly filter: RefundListFilter;
  readonly search: string | null;
  readonly sort: RefundSort;
  readonly page: number;
  readonly pageSize: number;
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
  if (fields.length === 0 && page * pageSize > MAX_PAGED_ROWS) {
    fields.push({ path: 'page', code: 'too-deep' });
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok({
    filter: {
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
    sort: { key, direction },
    page,
    pageSize,
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
): Promise<Result<RefundListPage, ReadFailure>> {
  const parsed = parse(input ?? {});
  if (!parsed.ok) return parsed;
  const { sort, page, pageSize } = parsed.value;
  let filter = parsed.value.filter;
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
      readonly total: number;
      readonly counts: RefundListPage['counts'];
    },
    ReadFailure
  >(
    context.market,
    async () => {
      const [records, total, counts] = await Promise.all([
        deps.refunds.page(context.market, filter, sort, (page - 1) * pageSize, pageSize),
        deps.refunds.count(context.market, filter),
        deps.refunds.countByState(context.market),
      ]);
      return ok({ records, total, counts });
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
    page,
    pageSize,
    searchCapped,
    searchScope,
  });
}
