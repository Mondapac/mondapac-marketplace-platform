import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AccountListCursor,
  AccountStatusCounts,
  ConnectedAccountListReader,
} from '../application/ports/connected-account-list.reader';
import { ACCOUNT_STATUSES, type AccountStatus } from '../domain/connected-account';
import type { AccountListFilter, AccountSort } from '../domain/connected-account-list';
import { record } from './prisma-connected-account-store';

const toDate = (instant: { epochMilliseconds: number }): Date =>
  new Date(instant.epochMilliseconds);

/**
 * The WHERE of a filter: the Market's rows only. `ready` is the domain's `isPayoutReady`
 * (enabled, and no waiting period running at `now`).
 */
function where(market: MarketContext, filter: AccountListFilter, withStatus = true) {
  const now = toDate(filter.now);
  const and: object[] = [];
  const readyClause = {
    status: 'enabled',
    OR: [{ coolingOffUntil: null }, { coolingOffUntil: { lte: now } }],
  };
  if (filter.ready === true) and.push(readyClause);
  if (filter.ready === false) and.push({ NOT: readyClause });
  if (filter.requirements === 'past-due') and.push({ requirementsPastDue: true });
  if (filter.requirements === 'due') and.push({ requirementsDue: { gt: 0 } });
  if (filter.requirements === 'none') {
    and.push({ requirementsDue: 0, requirementsPastDue: false });
  }
  if (filter.waiting === 'cooling-off') and.push({ coolingOffUntil: { gt: now } });
  if (filter.waiting === 'paused') and.push({ payoutsPausedUntil: { gt: now } });
  if (filter.from !== null || filter.to !== null) {
    and.push({
      createdAt: {
        ...(filter.from === null ? {} : { gte: toDate(filter.from) }),
        ...(filter.to === null ? {} : { lt: toDate(filter.to) }),
      },
    });
  }
  return {
    marketId: market.marketId,
    ...(withStatus && filter.status !== null ? { status: filter.status } : {}),
    ...(filter.sellerId === null ? {} : { sellerId: filter.sellerId }),
    ...(filter.sellerIds === null ? {} : { sellerId: { in: [...filter.sellerIds] } }),
    AND: and,
  };
}

/** The ORDER BY of a sort; the seller id breaks ties in the sort's direction. */
function order(sort: AccountSort) {
  const tie = { sellerId: sort.direction };
  switch (sort.key) {
    case 'last-read':
      // Never read: last when newest first, first when oldest first.
      return [
        {
          lastReadAt: {
            sort: sort.direction,
            nulls: sort.direction === 'desc' ? ('last' as const) : ('first' as const),
          },
        },
        tie,
      ];
    case 'requirements':
      return [{ requirementsPastDue: sort.direction }, { requirementsDue: sort.direction }, tie];
    default:
      return [{ createdAt: sort.direction }, tie];
  }
}

/**
 * {@link ConnectedAccountListReader} on Prisma. A Market has one row per seller that started a
 * payout account, so the sorts other than the primary key's are sorted rows, not an index walk.
 */
export class PrismaConnectedAccountListReader implements ConnectedAccountListReader {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    market: MarketContext,
    filter: AccountListFilter,
    sort: AccountSort,
    offset: number,
    limit: number,
    after: AccountListCursor | null = null,
  ) {
    const base = where(market, filter);
    const rows = await this.prisma.tx(market).paymentsConnectedAccount.findMany({
      where:
        after === null
          ? base
          : {
              ...base,
              AND: [
                ...base.AND,
                {
                  OR: [
                    { createdAt: { lt: toDate(after.createdAt) } },
                    { createdAt: toDate(after.createdAt), sellerId: { lt: after.sellerId } },
                  ],
                },
              ],
            },
      orderBy: after === null ? order(sort) : order({ key: 'created', direction: 'desc' }),
      skip: offset,
      take: limit,
    });
    return rows.map(record);
  }

  count(market: MarketContext, filter: AccountListFilter) {
    return this.prisma.tx(market).paymentsConnectedAccount.count({ where: where(market, filter) });
  }

  async countByStatus(market: MarketContext, filter: AccountListFilter) {
    const groups = await this.prisma.tx(market).paymentsConnectedAccount.groupBy({
      by: ['status'],
      where: where(market, filter, false),
      _count: { _all: true },
    });
    const counts = Object.fromEntries(ACCOUNT_STATUSES.map((status) => [status, 0])) as Record<
      AccountStatus,
      number
    >;
    for (const group of groups) {
      if ((ACCOUNT_STATUSES as readonly string[]).includes(group.status)) {
        counts[group.status as AccountStatus] = group._count._all;
      }
    }
    return counts as AccountStatusCounts;
  }

  async ids(market: MarketContext, filter: AccountListFilter, sort: AccountSort, limit: number) {
    const rows = await this.prisma.tx(market).paymentsConnectedAccount.findMany({
      where: where(market, filter),
      orderBy: order(sort),
      take: limit,
      select: { sellerId: true },
    });
    return rows.map((row) => row.sellerId);
  }

  async byIds(market: MarketContext, sellerIds: readonly string[]) {
    if (sellerIds.length === 0) return [];
    const rows = await this.prisma.tx(market).paymentsConnectedAccount.findMany({
      where: { marketId: market.marketId, sellerId: { in: [...sellerIds] } },
    });
    return rows.map(record);
  }
}
