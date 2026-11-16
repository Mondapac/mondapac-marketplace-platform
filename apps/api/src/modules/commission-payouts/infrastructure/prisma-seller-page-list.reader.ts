import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SellerPageListReader } from '../application/ports/seller-page-list.reader';
import type {
  HoldListCursor,
  HoldListFilter,
  HoldSort,
  HoldStatusCounts,
  LedgerListCursor,
  LedgerListFilter,
  LedgerSort,
} from '../domain/seller-page-lists';
import { toEntry } from './prisma-ledger.repository';
import { toRecord } from './prisma-payout-hold.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

const range = (from: Temporal.Instant | null, to: Temporal.Instant | null) =>
  from === null && to === null
    ? undefined
    : {
        ...(from === null ? {} : { gte: toDate(from) }),
        ...(to === null ? {} : { lt: toDate(to) }),
      };

/** The WHERE of a ledger filter: the Market's rows of the one seller only. */
function ledgerWhere(market: MarketContext, filter: LedgerListFilter) {
  const and: object[] = [];
  if (filter.kinds !== null) and.push({ kind: { in: [...filter.kinds] } });
  if (filter.reference !== null) {
    and.push({ OR: [{ orderId: filter.reference }, { sellerOrderId: filter.reference }] });
  }
  const recordedAt = range(filter.from, filter.to);
  return {
    marketId: market.marketId,
    sellerId: filter.sellerId,
    ...(recordedAt === undefined ? {} : { recordedAt }),
    ...(filter.minAmount === null && filter.maxAmount === null
      ? {}
      : {
          amount: {
            ...(filter.minAmount === null ? {} : { gte: filter.minAmount }),
            ...(filter.maxAmount === null ? {} : { lte: filter.maxAmount }),
          },
        }),
    AND: and,
  };
}

function ledgerOrder(sort: LedgerSort) {
  const tie = { id: sort.direction };
  switch (sort.key) {
    case 'occurred':
      return [{ occurredAt: sort.direction }, tie];
    case 'amount':
      return [{ amount: sort.direction }, tie];
    default:
      return [{ recordedAt: sort.direction }, tie];
  }
}

/** The WHERE of a holds filter: the Market's holds of the one seller only. */
function holdWhere(market: MarketContext, filter: HoldListFilter) {
  const placedAt = range(filter.from, filter.to);
  return {
    marketId: market.marketId,
    sellerId: filter.sellerId,
    ...(filter.status === null
      ? {}
      : { releasedAt: filter.status === 'active' ? null : { not: null } }),
    ...(filter.reason === null ? {} : { reason: filter.reason }),
    ...(filter.origin === null ? {} : { origin: filter.origin }),
    // A seller order id is a hold on that order; the scope says whole seller or one order.
    ...(filter.sellerOrderId !== null
      ? { sellerOrderId: filter.sellerOrderId }
      : filter.scope === null
        ? {}
        : { sellerOrderId: filter.scope === 'seller' ? null : { not: null } }),
    ...(placedAt === undefined ? {} : { placedAt }),
    AND: filter.sellerOrderId !== null && filter.scope === 'seller' ? [{ id: { in: [] } }] : [],
  };
}

function holdOrder(sort: HoldSort) {
  const tie = { id: sort.direction };
  switch (sort.key) {
    case 'released':
      return [{ releasedAt: { sort: sort.direction, nulls: 'last' as const } }, tie];
    case 'placed':
      return [{ placedAt: sort.direction }, tie];
    default:
      // Active first (no release time), then the newest placement (the direction flips both).
      return [
        {
          releasedAt: {
            sort: sort.direction === 'desc' ? ('desc' as const) : ('asc' as const),
            nulls: sort.direction === 'desc' ? ('first' as const) : ('last' as const),
          },
        },
        { placedAt: sort.direction },
        tie,
      ];
  }
}

/**
 * {@link SellerPageListReader} on `commission_payouts.ledger_entries` and `payout_holds`, scoped
 * by `marketId` and the seller in every `where`. Read-only.
 */
export class PrismaSellerPageListReader implements SellerPageListReader {
  constructor(private readonly prisma: PrismaService) {}

  async ledgerPage(
    market: MarketContext,
    filter: LedgerListFilter,
    sort: LedgerSort,
    offset: number,
    limit: number,
    after: LedgerListCursor | null = null,
  ) {
    const base = ledgerWhere(market, filter);
    const rows = await this.prisma.tx(market).commissionPayoutsLedgerEntry.findMany({
      where:
        after === null
          ? base
          : {
              ...base,
              AND: [
                ...base.AND,
                // The plain bound lets the index start at the cursor; the OR keeps the tie order.
                { recordedAt: { lte: toDate(after.recordedAt) } },
                {
                  OR: [
                    { recordedAt: { lt: toDate(after.recordedAt) } },
                    { recordedAt: toDate(after.recordedAt), id: { lt: after.entryId } },
                  ],
                },
              ],
            },
      orderBy: ledgerOrder(sort),
      skip: offset,
      take: limit,
    });
    return rows.map(toEntry);
  }

  async ledgerIds(
    market: MarketContext,
    filter: LedgerListFilter,
    sort: LedgerSort,
    limit: number,
  ) {
    const rows = await this.prisma.tx(market).commissionPayoutsLedgerEntry.findMany({
      where: ledgerWhere(market, filter),
      orderBy: ledgerOrder(sort),
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id as Id<'LedgerEntry'>);
  }

  ledgerCount(market: MarketContext, filter: LedgerListFilter) {
    return this.prisma
      .tx(market)
      .commissionPayoutsLedgerEntry.count({ where: ledgerWhere(market, filter) });
  }

  async ledgerByIds(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    ids: readonly Id<'LedgerEntry'>[],
  ) {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).commissionPayoutsLedgerEntry.findMany({
      where: { marketId: market.marketId, sellerId, id: { in: [...ids] } },
    });
    return rows.map(toEntry);
  }

  async holdPage(
    market: MarketContext,
    filter: HoldListFilter,
    sort: HoldSort,
    offset: number,
    limit: number,
    after: HoldListCursor | null = null,
  ) {
    const base = holdWhere(market, filter);
    const rows = await this.prisma.tx(market).commissionPayoutsPayoutHold.findMany({
      where:
        after === null
          ? base
          : {
              ...base,
              AND: [
                ...base.AND,
                { placedAt: { lte: toDate(after.placedAt) } },
                {
                  OR: [
                    { placedAt: { lt: toDate(after.placedAt) } },
                    { placedAt: toDate(after.placedAt), id: { lt: after.holdId } },
                  ],
                },
              ],
            },
      orderBy: holdOrder(sort),
      skip: offset,
      take: limit,
    });
    return rows.map(toRecord);
  }

  async holdIds(market: MarketContext, filter: HoldListFilter, sort: HoldSort, limit: number) {
    const rows = await this.prisma.tx(market).commissionPayoutsPayoutHold.findMany({
      where: holdWhere(market, filter),
      orderBy: holdOrder(sort),
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id as Id<'PayoutHold'>);
  }

  holdCount(market: MarketContext, filter: HoldListFilter) {
    return this.prisma
      .tx(market)
      .commissionPayoutsPayoutHold.count({ where: holdWhere(market, filter) });
  }

  async holdCounts(market: MarketContext, sellerId: Id<'Seller'>): Promise<HoldStatusCounts> {
    const tx = this.prisma.tx(market);
    const where = { marketId: market.marketId, sellerId };
    const active = await tx.commissionPayoutsPayoutHold.count({
      where: { ...where, releasedAt: null },
    });
    const all = await tx.commissionPayoutsPayoutHold.count({ where });
    return { active, released: all - active };
  }

  async holdByIds(market: MarketContext, sellerId: Id<'Seller'>, ids: readonly Id<'PayoutHold'>[]) {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).commissionPayoutsPayoutHold.findMany({
      where: { marketId: market.marketId, sellerId, id: { in: [...ids] } },
    });
    return rows.map(toRecord);
  }
}
