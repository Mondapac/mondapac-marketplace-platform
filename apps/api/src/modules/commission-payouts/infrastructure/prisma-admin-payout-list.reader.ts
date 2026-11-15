import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { AdminPayoutListReader } from '../application/ports/admin-payout-list.reader';
import type {
  PayoutListCursor,
  PayoutListFilter,
  PayoutSort,
  PayoutStateCounts,
} from '../domain/admin-payout-list';
import { PAYOUT_STATES, type PayoutState } from '../domain/payout';
import { toPayout } from './prisma-payout.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** The WHERE of a filter; every branch keeps the Market's own rows only. */
function where(market: MarketContext, filter: PayoutListFilter) {
  const and: object[] = [];
  // The view and the one state are both kept, so a state outside the view matches nothing.
  if (filter.states !== null) and.push({ state: { in: [...filter.states] } });
  if (filter.state !== null) and.push({ state: filter.state });
  if (filter.sellerIds !== null) and.push({ sellerId: { in: [...filter.sellerIds] } });
  return {
    marketId: market.marketId,
    ...(filter.payoutId === null ? {} : { id: filter.payoutId }),
    ...(filter.sellerId === null ? {} : { sellerId: filter.sellerId }),
    ...(filter.approvalMode === null ? {} : { approvalMode: filter.approvalMode }),
    ...(filter.from === null && filter.to === null
      ? {}
      : {
          createdAt: {
            ...(filter.from === null ? {} : { gte: toDate(filter.from) }),
            ...(filter.to === null ? {} : { lt: toDate(filter.to) }),
          },
        }),
    ...(filter.minAmount === null && filter.maxAmount === null
      ? {}
      : {
          transferMinor: {
            ...(filter.minAmount === null ? {} : { gte: filter.minAmount }),
            ...(filter.maxAmount === null ? {} : { lte: filter.maxAmount }),
          },
        }),
    AND: and,
  };
}

function orderBy(sort: PayoutSort) {
  const tie = { id: sort.direction };
  switch (sort.key) {
    case 'amount':
      return [{ transferMinor: sort.direction }, tie];
    case 'state-changed':
      return [{ stateChangedAt: sort.direction }, tie];
    case 'slot':
      return [{ slotAt: sort.direction }, tie];
    default:
      return [{ createdAt: sort.direction }, tie];
  }
}

/**
 * {@link AdminPayoutListReader} on `commission_payouts.payouts` (and `payout_holds` for the
 * Release action), scoped by `marketId` in every `where`. Read-only.
 */
export class PrismaAdminPayoutListReader implements AdminPayoutListReader {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    market: MarketContext,
    filter: PayoutListFilter,
    sort: PayoutSort,
    offset: number,
    limit: number,
    after: PayoutListCursor | null = null,
  ) {
    const base = where(market, filter);
    const rows = await this.prisma.tx(market).commissionPayoutsPayout.findMany({
      where:
        after === null
          ? base
          : {
              ...base,
              AND: [
                ...base.AND,
                // The plain bound lets the index start at the cursor; the OR keeps the tie order.
                { createdAt: { lte: toDate(after.createdAt) } },
                {
                  OR: [
                    { createdAt: { lt: toDate(after.createdAt) } },
                    { createdAt: toDate(after.createdAt), id: { lt: after.payoutId } },
                  ],
                },
              ],
            },
      orderBy: orderBy(sort),
      skip: offset,
      take: limit,
    });
    return rows.map(toPayout);
  }

  count(market: MarketContext, filter: PayoutListFilter) {
    return this.prisma.tx(market).commissionPayoutsPayout.count({ where: where(market, filter) });
  }

  async countByState(market: MarketContext): Promise<PayoutStateCounts> {
    const groups = await this.prisma.tx(market).commissionPayoutsPayout.groupBy({
      by: ['state'],
      where: { marketId: market.marketId },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(PAYOUT_STATES.map((state) => [state, 0])) as Record<
      PayoutState,
      number
    >;
    for (const group of groups) {
      if ((PAYOUT_STATES as readonly string[]).includes(group.state)) {
        counts[group.state as PayoutState] = group._count._all;
      }
    }
    return counts;
  }

  async byIds(market: MarketContext, ids: readonly Id<'Payout'>[]) {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).commissionPayoutsPayout.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] } },
    });
    return rows.map(toPayout);
  }

  async activeAdminHolds(market: MarketContext, sellerIds: readonly Id<'Seller'>[]) {
    const holds = new Map<Id<'Seller'>, Id<'PayoutHold'>>();
    if (sellerIds.length === 0) return holds;
    const rows = await this.prisma.tx(market).commissionPayoutsPayoutHold.findMany({
      where: {
        marketId: market.marketId,
        sellerId: { in: [...sellerIds] },
        origin: 'admin',
        sellerOrderId: null,
        releasedAt: null,
      },
      select: { id: true, sellerId: true },
      orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
    });
    // Newest first: the first hold of a seller is the one its Release action releases.
    for (const row of rows) {
      const sellerId = row.sellerId as Id<'Seller'>;
      if (!holds.has(sellerId)) holds.set(sellerId, row.id as Id<'PayoutHold'>);
    }
    return holds;
  }
}
