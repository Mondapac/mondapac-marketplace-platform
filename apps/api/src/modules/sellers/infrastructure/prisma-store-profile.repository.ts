import { money } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Money } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  StoreProfileRepository,
  StoreSettings,
} from '../application/ports/store-profile.repository';

const MAX_IDS = 100;

const minimumOf = (row: {
  minimumOrderAmount: bigint | null;
  minimumOrderCurrency: string | null;
}): Money | null =>
  row.minimumOrderAmount === null || row.minimumOrderCurrency === null
    ? null
    : money(row.minimumOrderAmount, row.minimumOrderCurrency);

/**
 * {@link StoreProfileRepository} on `sellers.store_profiles`, joined to its seller file for the
 * approved pointer (data design 3.8, A1): one statement per batch, no N+1.
 */
export class PrismaStoreProfileRepository implements StoreProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async approvedMinimumOrders(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, Money | null>> {
    if (sellerIds.length === 0) return new Map();
    if (sellerIds.length > MAX_IDS) throw new RangeError('approvedMinimumOrders: at most 100 ids');
    const rows = await this.prisma.tx(market).sellersStoreProfile.findMany({
      where: {
        marketId: market.marketId,
        sellerId: { in: [...sellerIds] },
        sellerFile: { approvedRevisionId: { not: null } },
      },
      select: { sellerId: true, minimumOrderAmount: true, minimumOrderCurrency: true },
    });
    return new Map(rows.map((row) => [row.sellerId as Id<'Seller'>, minimumOf(row)] as const));
  }

  async approvedStoreNames(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string>> {
    if (sellerIds.length === 0) return new Map();
    if (sellerIds.length > MAX_IDS) throw new RangeError('approvedStoreNames: at most 100 ids');
    // `public_store_name` is set exactly while the approved pointer is set (CHECK).
    const rows = await this.prisma.tx(market).sellersSellerFile.findMany({
      where: {
        marketId: market.marketId,
        sellerId: { in: [...sellerIds] },
        approvedRevisionId: { not: null },
        publicStoreName: { not: null },
      },
      select: { sellerId: true, publicStoreName: true },
    });
    const names = new Map<Id<'Seller'>, string>();
    for (const row of rows) {
      if (row.publicStoreName !== null)
        names.set(row.sellerId as Id<'Seller'>, row.publicStoreName);
    }
    return names;
  }

  async find(market: MarketContext, sellerId: Id<'Seller'>): Promise<StoreSettings | null> {
    const row = await this.prisma.tx(market).sellersStoreProfile.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: {
        version: true,
        minimumOrderAmount: true,
        minimumOrderCurrency: true,
        sellerFile: { select: { approvedRevisionId: true } },
      },
    });
    if (row === null) return null;
    return {
      version: row.version,
      approved: row.sellerFile.approvedRevisionId !== null,
      minimumOrder: minimumOf(row),
    };
  }

  async saveMinimumOrder(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: Parameters<StoreProfileRepository['saveMinimumOrder']>[2],
  ): Promise<number | null> {
    const result = await this.prisma.tx(market).sellersStoreProfile.updateMany({
      where: { marketId: market.marketId, sellerId, version: change.expectedVersion },
      data: {
        minimumOrderAmount: change.minimumOrder?.amount ?? null,
        minimumOrderCurrency: change.minimumOrder?.currency ?? null,
        minimumOrderChangedAt: new Date(change.changedAt.epochMilliseconds),
        minimumOrderChangedByAccountId: change.changedByAccountId,
        version: { increment: 1 },
      },
    });
    return result.count === 1 ? change.expectedVersion + 1 : null;
  }
}
