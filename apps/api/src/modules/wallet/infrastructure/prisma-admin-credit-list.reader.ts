import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { AdminCreditListReader } from '../application/ports/admin-credit-list.reader';
import { ADMIN_CREDIT_STATUSES, type AdminCreditStatus } from '../domain/admin-credit';
import type {
  CreditListCursor,
  CreditListFilter,
  CreditSort,
  CreditStatusCounts,
} from '../domain/admin-credit-list';
import { toRecord } from './prisma-admin-credit.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** The WHERE of a filter; every branch keeps the Market's own rows only. */
function where(market: MarketContext, filter: CreditListFilter) {
  const and: object[] = [];
  // The view and the one status are both kept, so a status outside the view matches nothing.
  if (filter.statuses !== null) and.push({ status: { in: [...filter.statuses] } });
  if (filter.status !== null) and.push({ status: filter.status });
  if (filter.requestOrCustomerId !== null) {
    and.push({
      OR: [{ id: filter.requestOrCustomerId }, { customerAccountId: filter.requestOrCustomerId }],
    });
  }
  return {
    marketId: market.marketId,
    ...(filter.reason === null ? {} : { reasonCode: filter.reason }),
    ...(filter.approvalReason === null ? {} : { approvalReason: filter.approvalReason }),
    ...(filter.requestedBy === null ? {} : { requestedByAccountId: filter.requestedBy }),
    ...(filter.from === null && filter.to === null
      ? {}
      : {
          requestedAt: {
            ...(filter.from === null ? {} : { gte: toDate(filter.from) }),
            ...(filter.to === null ? {} : { lt: toDate(filter.to) }),
          },
        }),
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

function orderBy(sort: CreditSort) {
  const tie = { id: sort.direction };
  switch (sort.key) {
    case 'amount':
      return [{ amountMinor: sort.direction }, tie];
    case 'expires':
      // Granted at once has no expiry: last either way.
      return [{ expiresAt: { sort: sort.direction, nulls: 'last' as const } }, tie];
    case 'decided':
      // Not decided yet: last either way.
      return [{ decidedAt: { sort: sort.direction, nulls: 'last' as const } }, tie];
    default:
      return [{ requestedAt: sort.direction }, tie];
  }
}

/**
 * {@link AdminCreditListReader} on `wallet.admin_credit_requests`, scoped by `marketId` in every
 * `where`. Read-only.
 */
export class PrismaAdminCreditListReader implements AdminCreditListReader {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    market: MarketContext,
    filter: CreditListFilter,
    sort: CreditSort,
    offset: number,
    limit: number,
    after: CreditListCursor | null = null,
  ) {
    const base = where(market, filter);
    const rows = await this.prisma.tx(market).walletAdminCreditRequest.findMany({
      where:
        after === null
          ? base
          : {
              ...base,
              AND: [
                ...base.AND,
                // The plain bound lets the index start at the cursor; the OR keeps the tie order.
                { requestedAt: { lte: toDate(after.requestedAt) } },
                {
                  OR: [
                    { requestedAt: { lt: toDate(after.requestedAt) } },
                    { requestedAt: toDate(after.requestedAt), id: { lt: after.id } },
                  ],
                },
              ],
            },
      orderBy: orderBy(sort),
      skip: offset,
      take: limit,
    });
    return rows.map(toRecord);
  }

  async idsPage(market: MarketContext, filter: CreditListFilter, sort: CreditSort, limit: number) {
    const rows = await this.prisma.tx(market).walletAdminCreditRequest.findMany({
      where: where(market, filter),
      orderBy: orderBy(sort),
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id as Id<'WalletCreditRequest'>);
  }

  count(market: MarketContext, filter: CreditListFilter) {
    return this.prisma.tx(market).walletAdminCreditRequest.count({ where: where(market, filter) });
  }

  async countByStatus(market: MarketContext): Promise<CreditStatusCounts> {
    const groups = await this.prisma.tx(market).walletAdminCreditRequest.groupBy({
      by: ['status'],
      where: { marketId: market.marketId },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(ADMIN_CREDIT_STATUSES.map((s) => [s, 0])) as Record<
      AdminCreditStatus,
      number
    >;
    for (const group of groups) {
      if ((ADMIN_CREDIT_STATUSES as readonly string[]).includes(group.status)) {
        counts[group.status as AdminCreditStatus] = group._count._all;
      }
    }
    return counts;
  }

  async byIds(market: MarketContext, ids: readonly Id<'WalletCreditRequest'>[]) {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).walletAdminCreditRequest.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] } },
    });
    return rows.map(toRecord);
  }
}
