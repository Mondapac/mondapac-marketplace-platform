import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { AdminDeletionListReader } from '../application/ports/admin-deletion-list.reader';
import type { AccountDeletionRequestStatus } from '../domain/account-deletion-request';
import {
  DELETION_CANCEL_REASONS,
  DELETION_REQUEST_STATUSES,
  type DeletionCancelReason,
  type DeletionListCursor,
  type DeletionListFilter,
  type DeletionListRow,
  type DeletionSort,
  type DeletionStatusCounts,
} from '../domain/admin-deletion-list';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** The columns of a row: ids, a status and times. The ticket and the reason are never selected. */
const SELECT = {
  id: true,
  accountId: true,
  status: true,
  requestedBy: true,
  requestedAt: true,
  scheduledFor: true,
  cancelledAt: true,
  cancelReason: true,
  completedAt: true,
} as const;

const toRow = (row: {
  readonly id: string;
  readonly accountId: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly scheduledFor: Date;
  readonly cancelledAt: Date | null;
  readonly cancelReason: string | null;
  readonly completedAt: Date | null;
}): DeletionListRow => ({
  id: row.id as Id<'AccountDeletionRequest'>,
  accountId: row.accountId as Id<'Account'>,
  status: row.status as AccountDeletionRequestStatus,
  requestedBy: row.requestedBy === 'admin' ? 'admin' : 'customer',
  requestedAt: toInstant(row.requestedAt),
  scheduledFor: toInstant(row.scheduledFor),
  cancelledAt: row.cancelledAt === null ? null : toInstant(row.cancelledAt),
  cancelReason: (DELETION_CANCEL_REASONS as readonly (string | null)[]).includes(row.cancelReason)
    ? (row.cancelReason as DeletionCancelReason)
    : null,
  completedAt: row.completedAt === null ? null : toInstant(row.completedAt),
});

/** The WHERE of a filter; every branch keeps the Market's own rows only. */
function where(market: MarketContext, filter: DeletionListFilter) {
  const and: object[] = [];
  if (filter.requestOrAccountId !== null) {
    and.push({
      OR: [{ id: filter.requestOrAccountId }, { accountId: filter.requestOrAccountId }],
    });
  }
  return {
    marketId: market.marketId,
    ...(filter.status === null ? {} : { status: filter.status }),
    ...(filter.requestedBy === null ? {} : { requestedBy: filter.requestedBy }),
    ...(filter.cancelReason === null ? {} : { cancelReason: filter.cancelReason }),
    ...(filter.from === null && filter.to === null
      ? {}
      : {
          requestedAt: {
            ...(filter.from === null ? {} : { gte: toDate(filter.from) }),
            ...(filter.to === null ? {} : { lt: toDate(filter.to) }),
          },
        }),
    ...(filter.scheduledBefore === null
      ? {}
      : { scheduledFor: { lt: toDate(filter.scheduledBefore) } }),
    AND: and,
  };
}

function orderBy(sort: DeletionSort) {
  const tie = { id: sort.direction };
  switch (sort.key) {
    case 'requested':
      return [{ requestedAt: sort.direction }, tie];
    case 'cancelled':
      // Not cancelled: last either way.
      return [{ cancelledAt: { sort: sort.direction, nulls: 'last' as const } }, tie];
    case 'completed':
      // Not completed: last either way.
      return [{ completedAt: { sort: sort.direction, nulls: 'last' as const } }, tie];
    default:
      return [{ scheduledFor: sort.direction }, tie];
  }
}

/**
 * {@link AdminDeletionListReader} on `customers.account_deletion_requests`, scoped by `marketId` in
 * every `where`. Read-only.
 */
export class PrismaAdminDeletionListReader implements AdminDeletionListReader {
  constructor(private readonly prisma: PrismaService) {}

  async page(
    market: MarketContext,
    filter: DeletionListFilter,
    sort: DeletionSort,
    offset: number,
    limit: number,
    after: DeletionListCursor | null = null,
  ) {
    const base = where(market, filter);
    const rows = await this.prisma.tx(market).customersAccountDeletionRequest.findMany({
      where:
        after === null
          ? base
          : {
              ...base,
              AND: [
                ...base.AND,
                // The plain bound lets the index start at the cursor; the OR keeps the tie order.
                { scheduledFor: { gte: toDate(after.scheduledFor) } },
                {
                  OR: [
                    { scheduledFor: { gt: toDate(after.scheduledFor) } },
                    { scheduledFor: toDate(after.scheduledFor), id: { gt: after.id } },
                  ],
                },
              ],
            },
      orderBy: orderBy(sort),
      skip: offset,
      take: limit,
      select: SELECT,
    });
    return rows.map(toRow);
  }

  async idsPage(
    market: MarketContext,
    filter: DeletionListFilter,
    sort: DeletionSort,
    limit: number,
  ) {
    const rows = await this.prisma.tx(market).customersAccountDeletionRequest.findMany({
      where: where(market, filter),
      orderBy: orderBy(sort),
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id as Id<'AccountDeletionRequest'>);
  }

  count(market: MarketContext, filter: DeletionListFilter) {
    return this.prisma
      .tx(market)
      .customersAccountDeletionRequest.count({ where: where(market, filter) });
  }

  async countByStatus(market: MarketContext): Promise<DeletionStatusCounts> {
    const groups = await this.prisma.tx(market).customersAccountDeletionRequest.groupBy({
      by: ['status'],
      where: { marketId: market.marketId },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(DELETION_REQUEST_STATUSES.map((s) => [s, 0])) as Record<
      AccountDeletionRequestStatus,
      number
    >;
    for (const group of groups) {
      if ((DELETION_REQUEST_STATUSES as readonly string[]).includes(group.status)) {
        counts[group.status as AccountDeletionRequestStatus] = group._count._all;
      }
    }
    return counts;
  }

  async byIds(market: MarketContext, ids: readonly Id<'AccountDeletionRequest'>[]) {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).customersAccountDeletionRequest.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] } },
      select: SELECT,
    });
    return rows.map(toRow);
  }
}
