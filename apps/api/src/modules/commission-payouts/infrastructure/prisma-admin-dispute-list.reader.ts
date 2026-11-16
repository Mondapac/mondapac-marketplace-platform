import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { AdminDisputeListReader } from '../application/ports/admin-dispute-list.reader';
import type {
  DisputeBucketCounts,
  DisputeListCursor,
  DisputeListFilter,
  DisputeSort,
} from '../domain/admin-dispute-list';
import { DISPUTE_BUCKETS, type DisputeBucket } from '../domain/dispute';
import { toCase } from './prisma-dispute.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** The money state as stored flags, the same order of checks as `moneyStateOf`. */
function moneyWhere(state: DisputeListFilter['moneyState']) {
  switch (state) {
    case 'reinstated':
      return { fundsReinstated: true };
    case 'withdrawn':
      return { fundsReinstated: false, fundsWithdrawn: true };
    case 'inquiry':
      return { fundsReinstated: false, fundsWithdrawn: false, inquiry: true };
    case 'none':
      return { fundsReinstated: false, fundsWithdrawn: false, inquiry: false };
    default:
      return {};
  }
}

/** The WHERE of a filter; every branch keeps the Market's own rows only. */
function where(market: MarketContext, filter: DisputeListFilter) {
  const and: object[] = [];
  if (filter.caseOrOrderId !== null) {
    and.push({ OR: [{ disputeId: filter.caseOrOrderId }, { orderId: filter.caseOrOrderId }] });
  }
  if (filter.orderIds !== null) and.push({ orderId: { in: [...filter.orderIds] } });
  return {
    marketId: market.marketId,
    ...(filter.bucket === null ? {} : { bucket: filter.bucket }),
    ...(filter.status === null ? {} : { status: filter.status }),
    ...moneyWhere(filter.moneyState),
    ...(filter.from === null && filter.to === null
      ? {}
      : {
          openedAt: {
            ...(filter.from === null ? {} : { gte: toDate(filter.from) }),
            ...(filter.to === null ? {} : { lt: toDate(filter.to) }),
          },
        }),
    ...(filter.dueBefore === null ? {} : { evidenceDueBy: { lt: toDate(filter.dueBefore) } }),
    ...(filter.minAmount === null && filter.maxAmount === null
      ? {}
      : {
          amountMinor: {
            ...(filter.minAmount === null ? {} : { gte: filter.minAmount }),
            ...(filter.maxAmount === null ? {} : { lte: filter.maxAmount }),
          },
        }),
    AND: and,
  };
}

function orderBy(sort: DisputeSort) {
  const tie = { disputeId: sort.direction };
  switch (sort.key) {
    case 'amount':
      return [{ amountMinor: sort.direction }, tie];
    case 'evidence-due':
      // A case without a deadline sorts last either way: the panel reads it as "nothing due".
      return [{ evidenceDueBy: { sort: sort.direction, nulls: 'last' as const } }, tie];
    case 'updated':
      return [{ updatedAt: sort.direction }, tie];
    default:
      return [{ openedAt: sort.direction }, tie];
  }
}

/**
 * {@link AdminDisputeListReader} on `commission_payouts.dispute_cases` (and `ledger_entries` for
 * the seller filter), scoped by `marketId` in every `where`. Read-only.
 */
export class PrismaAdminDisputeListReader implements AdminDisputeListReader {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    market: MarketContext,
    filter: DisputeListFilter,
    sort: DisputeSort,
    offset: number,
    limit: number,
    after: DisputeListCursor | null = null,
  ) {
    const base = where(market, filter);
    const rows = await this.prisma.tx(market).commissionPayoutsDisputeCase.findMany({
      where:
        after === null
          ? base
          : {
              ...base,
              AND: [
                ...base.AND,
                // The plain bound lets the index start at the cursor; the OR keeps the tie order.
                { openedAt: { lte: toDate(after.openedAt) } },
                {
                  OR: [
                    { openedAt: { lt: toDate(after.openedAt) } },
                    { openedAt: toDate(after.openedAt), disputeId: { lt: after.disputeId } },
                  ],
                },
              ],
            },
      orderBy: orderBy(sort),
      skip: offset,
      take: limit,
    });
    return rows.map(toCase);
  }

  async idsPage(
    market: MarketContext,
    filter: DisputeListFilter,
    sort: DisputeSort,
    limit: number,
  ) {
    const rows = await this.prisma.tx(market).commissionPayoutsDisputeCase.findMany({
      where: where(market, filter),
      orderBy: orderBy(sort),
      take: limit,
      select: { disputeId: true },
    });
    return rows.map((row) => row.disputeId as Id<'Dispute'>);
  }

  count(market: MarketContext, filter: DisputeListFilter) {
    return this.prisma
      .tx(market)
      .commissionPayoutsDisputeCase.count({ where: where(market, filter) });
  }

  async countByBucket(market: MarketContext): Promise<DisputeBucketCounts> {
    const groups = await this.prisma.tx(market).commissionPayoutsDisputeCase.groupBy({
      by: ['bucket'],
      where: { marketId: market.marketId },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(DISPUTE_BUCKETS.map((bucket) => [bucket, 0])) as Record<
      DisputeBucket,
      number
    >;
    for (const group of groups) {
      if ((DISPUTE_BUCKETS as readonly string[]).includes(group.bucket)) {
        counts[group.bucket as DisputeBucket] = group._count._all;
      }
    }
    return counts;
  }

  async byIds(market: MarketContext, ids: readonly Id<'Dispute'>[]) {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).commissionPayoutsDisputeCase.findMany({
      where: { marketId: market.marketId, disputeId: { in: [...ids] } },
    });
    return rows.map(toCase);
  }

  async disputedOrdersOfSellers(market: MarketContext, sellerIds: readonly Id<'Seller'>[]) {
    if (sellerIds.length === 0) return [];
    const disputed = await this.prisma.tx(market).commissionPayoutsDisputeCase.findMany({
      where: { marketId: market.marketId },
      select: { orderId: true },
      distinct: ['orderId'],
    });
    if (disputed.length === 0) return [];
    const groups = await this.prisma.tx(market).commissionPayoutsLedgerEntry.groupBy({
      by: ['orderId'],
      where: {
        marketId: market.marketId,
        sellerId: { in: [...sellerIds] },
        orderId: { in: disputed.map((row) => row.orderId) },
      },
      orderBy: [{ orderId: 'asc' }],
    });
    return groups.map((group) => group.orderId as Id<'Order'>);
  }
}
