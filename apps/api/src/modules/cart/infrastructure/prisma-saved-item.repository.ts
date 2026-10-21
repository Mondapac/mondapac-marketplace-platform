import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SavedItem, SavedItemRepository } from '../application/ports/saved-item.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

interface Row {
  readonly id: string;
  readonly accountId: string;
  readonly offerId: string;
  readonly variantId: string;
  readonly savedAt: Date;
}

const toItem = (row: Row): SavedItem => ({
  id: row.id as Id<'SavedItem'>,
  accountId: row.accountId as Id<'Account'>,
  offerId: row.offerId as Id<'Offer'>,
  variantId: row.variantId as Id<'Variant'>,
  savedAt: Temporal.Instant.fromEpochMilliseconds(row.savedAt.getTime()),
});

const SELECT = {
  id: true,
  accountId: true,
  offerId: true,
  variantId: true,
  savedAt: true,
} as const;

/** {@link SavedItemRepository} on `cart.saved_items`, through the Market-scoped client. */
export class PrismaSavedItemRepository implements SavedItemRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(market: MarketContext, accountId: Id<'Account'>, limit: number) {
    const rows = await this.prisma.tx(market).cartSavedItem.findMany({
      where: { marketId: market.marketId, accountId },
      orderBy: [{ savedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: SELECT,
    });
    return rows.map(toItem);
  }

  async find(market: MarketContext, accountId: Id<'Account'>, id: Id<'SavedItem'>) {
    const row = await this.prisma.tx(market).cartSavedItem.findFirst({
      where: { marketId: market.marketId, accountId, id },
      select: SELECT,
    });
    return row === null ? null : toItem(row);
  }

  count(market: MarketContext, accountId: Id<'Account'>) {
    return this.prisma
      .tx(market)
      .cartSavedItem.count({ where: { marketId: market.marketId, accountId } });
  }

  async upsert(market: MarketContext, item: SavedItem) {
    const row = await this.prisma.tx(market).cartSavedItem.upsert({
      where: {
        marketId: market.marketId,
        marketId_accountId_offerId_variantId: {
          marketId: market.marketId,
          accountId: item.accountId,
          offerId: item.offerId,
          variantId: item.variantId,
        },
      },
      create: {
        id: item.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        accountId: item.accountId,
        offerId: item.offerId,
        variantId: item.variantId,
        savedAt: toDate(item.savedAt),
      },
      update: { savedAt: toDate(item.savedAt) },
      select: SELECT,
    });
    return toItem(row);
  }

  async delete(market: MarketContext, accountId: Id<'Account'>, id: Id<'SavedItem'>) {
    const { count } = await this.prisma.tx(market).cartSavedItem.deleteMany({
      where: { marketId: market.marketId, accountId, id },
    });
    return count > 0;
  }

  async purgeSavedBefore(market: MarketContext, before: Temporal.Instant, limit: number) {
    const tx = this.prisma.tx(market);
    const old = { marketId: market.marketId, savedAt: { lte: toDate(before) } };
    const rows = await tx.cartSavedItem.findMany({
      where: old,
      orderBy: [{ savedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const { count } = await tx.cartSavedItem.deleteMany({
      where: { ...old, id: { in: rows.map((row) => row.id) } },
    });
    return count;
  }
}
