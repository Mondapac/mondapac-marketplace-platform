import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { AdminDisputeListReader } from '../../src/modules/commission-payouts/application/ports/admin-dispute-list.reader';
import type {
  DisputeBucketCounts,
  DisputeListCursor,
  DisputeListFilter,
  DisputeSort,
} from '../../src/modules/commission-payouts/domain/admin-dispute-list';
import {
  DISPUTE_BUCKETS,
  moneyStateOf,
  type DisputeBucket,
  type DisputeCase,
} from '../../src/modules/commission-payouts/domain/dispute';
import type { MarketLedger, MemoryDisputes } from './commission-payouts-dispute-fakes';

// In-memory stand-in for the admin Disputes list (super list 23): the reader works over the same
// cases as MemoryDisputes and the same ledger rows as MarketLedger, with the filter, sort and
// cursor of the Prisma reader.

const inMarket = (market: MarketContext, k: string) => k.startsWith(`${market.marketId}:`);

function matches(c: DisputeCase, filter: DisputeListFilter): boolean {
  if (filter.bucket !== null && c.bucket !== filter.bucket) return false;
  if (filter.status !== null && c.status !== filter.status) return false;
  if (filter.moneyState !== null && moneyStateOf(c) !== filter.moneyState) return false;
  if (
    filter.caseOrOrderId !== null &&
    c.disputeId !== filter.caseOrOrderId &&
    c.orderId !== filter.caseOrOrderId
  ) {
    return false;
  }
  if (filter.orderIds !== null && !filter.orderIds.includes(c.orderId)) return false;
  if (filter.from !== null && Temporal.Instant.compare(c.openedAt, filter.from) < 0) return false;
  if (filter.to !== null && Temporal.Instant.compare(c.openedAt, filter.to) >= 0) return false;
  if (
    filter.dueBefore !== null &&
    (c.evidenceDueBy === null || Temporal.Instant.compare(c.evidenceDueBy, filter.dueBefore) >= 0)
  ) {
    return false;
  }
  if (filter.minAmount !== null && c.amount.amount < filter.minAmount) return false;
  if (filter.maxAmount !== null && c.amount.amount > filter.maxAmount) return false;
  return true;
}

function compare(a: DisputeCase, b: DisputeCase, sort: DisputeSort): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  let order: number;
  switch (sort.key) {
    case 'amount':
      order = a.amount.amount < b.amount.amount ? -1 : a.amount.amount > b.amount.amount ? 1 : 0;
      break;
    case 'evidence-due': {
      // No deadline sorts last either way.
      if (a.evidenceDueBy === null || b.evidenceDueBy === null) {
        if (a.evidenceDueBy !== b.evidenceDueBy) return a.evidenceDueBy === null ? 1 : -1;
        order = 0;
      } else order = Temporal.Instant.compare(a.evidenceDueBy, b.evidenceDueBy);
      break;
    }
    case 'updated':
      order = Temporal.Instant.compare(a.updatedAt, b.updatedAt);
      break;
    default:
      order = Temporal.Instant.compare(a.openedAt, b.openedAt);
  }
  if (order === 0) order = a.disputeId < b.disputeId ? -1 : a.disputeId > b.disputeId ? 1 : 0;
  return order * sign;
}

export class MemoryAdminDisputeList implements AdminDisputeListReader {
  /** Every read, so a test can see that nothing was read before a refusal. */
  reads = 0;

  constructor(
    private readonly disputes: MemoryDisputes,
    private readonly ledger: MarketLedger,
  ) {}

  #rows(market: MarketContext): DisputeCase[] {
    this.reads += 1;
    return [...this.disputes.cases.entries()]
      .filter(([k]) => inMarket(market, k))
      .map(([, c]) => c);
  }

  page(
    market: MarketContext,
    filter: DisputeListFilter,
    sort: DisputeSort,
    offset: number,
    limit: number,
    after: DisputeListCursor | null = null,
  ) {
    const rows = this.#rows(market)
      .filter((c) => matches(c, filter))
      .filter(
        (c) =>
          after === null ||
          Temporal.Instant.compare(c.openedAt, after.openedAt) < 0 ||
          (Temporal.Instant.compare(c.openedAt, after.openedAt) === 0 &&
            c.disputeId < after.disputeId),
      )
      .sort((a, b) => compare(a, b, sort));
    return Promise.resolve(rows.slice(offset, offset + limit));
  }

  async idsPage(
    market: MarketContext,
    filter: DisputeListFilter,
    sort: DisputeSort,
    limit: number,
  ) {
    return (await this.page(market, filter, sort, 0, limit)).map((c) => c.disputeId);
  }

  count(market: MarketContext, filter: DisputeListFilter) {
    return Promise.resolve(this.#rows(market).filter((c) => matches(c, filter)).length);
  }

  countByBucket(market: MarketContext): Promise<DisputeBucketCounts> {
    const counts = Object.fromEntries(DISPUTE_BUCKETS.map((b) => [b, 0])) as Record<
      DisputeBucket,
      number
    >;
    for (const c of this.#rows(market)) counts[c.bucket] += 1;
    return Promise.resolve(counts);
  }

  byIds(market: MarketContext, ids: readonly Id<'Dispute'>[]) {
    return Promise.resolve(this.#rows(market).filter((c) => ids.includes(c.disputeId)));
  }

  disputedOrdersOfSellers(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
    limit: number,
  ) {
    const disputed = new Set<string>(this.#rows(market).map((c) => c.orderId));
    const found = new Set<Id<'Order'>>();
    for (const row of this.ledger.all(market)) {
      if (sellerIds.includes(row.sellerId) && disputed.has(row.orderId)) found.add(row.orderId);
    }
    return Promise.resolve([...found].sort().slice(0, limit));
  }
}
