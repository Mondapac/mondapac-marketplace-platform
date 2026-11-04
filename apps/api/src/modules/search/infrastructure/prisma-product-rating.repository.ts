import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ProductRatingRepository,
  StoredProductRating,
} from '../application/ports/product-rating';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** {@link ProductRatingRepository} over Prisma. The Market and tenant come from the unit. */
export class PrismaProductRatingRepository implements ProductRatingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsertMany(
    market: MarketContext,
    rows: readonly StoredProductRating[],
    syncedAt: Temporal.Instant,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    for (const row of rows) {
      const data = {
        ratingCount: row.count,
        ratingSum: row.sum,
        bayesTimes1000: row.bayesTimes1000,
        boostPpm: row.boostPpm,
        syncedAt: toDate(syncedAt),
      };
      // A late run never overwrites a fresher one: update only a row not newer than this run,
      // and create it only when it does not exist (a row that is newer is left as it is).
      const updated = await tx.searchProductRating.updateMany({
        where: {
          marketId: market.marketId,
          productId: row.productId,
          syncedAt: { lte: data.syncedAt },
        },
        data,
      });
      if (updated.count === 0) {
        await tx.searchProductRating.createMany({
          data: [
            {
              marketId: market.marketId,
              tenantId: market.tenantId,
              productId: row.productId,
              ...data,
            },
          ],
          skipDuplicates: true,
        });
      }
    }
  }

  async deleteSyncedBefore(market: MarketContext, before: Temporal.Instant): Promise<number> {
    const { count } = await this.prisma.tx(market).searchProductRating.deleteMany({
      where: { marketId: market.marketId, syncedAt: { lt: toDate(before) } },
    });
    return count;
  }

  async deleteAll(market: MarketContext): Promise<number> {
    const { count } = await this.prisma.tx(market).searchProductRating.deleteMany({
      where: { marketId: market.marketId },
    });
    return count;
  }
}
