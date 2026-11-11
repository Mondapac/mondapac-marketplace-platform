import type { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CategoryProposalsSettingRepository,
  CategoryProposalsSettingState,
} from '../application/ports/category-proposals-setting.repository';

/** {@link CategoryProposalsSettingRepository} on `sellers.seller_admin_settings`, by Market. */
export class PrismaCategoryProposalsSettingRepository implements CategoryProposalsSettingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async lock(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<CategoryProposalsSettingState | null> {
    const settings = this.prisma.tx(market).sellersSellerAdminSettings;
    // Raising the version takes the row lock until the unit ends (the guarded client sends no raw
    // SQL); the read after it sees what was committed before the lock.
    const { count } = await settings.updateMany({
      where: { marketId: market.marketId, sellerId },
      data: { version: { increment: 1 } },
    });
    if (count === 0) return null;
    const row = await settings.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: { categoryProposalsAllowed: true, version: true },
    });
    return row === null ? null : { allowed: row.categoryProposalsAllowed, version: row.version };
  }

  async set(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: {
      readonly allowed: boolean;
      readonly by: Id<'Account'>;
      readonly at: Temporal.Instant;
    },
  ): Promise<void> {
    await this.prisma.tx(market).sellersSellerAdminSettings.updateMany({
      where: { marketId: market.marketId, sellerId },
      data: {
        categoryProposalsAllowed: change.allowed,
        categoryProposalsChangedAt: new Date(change.at.epochMilliseconds),
        categoryProposalsChangedByAccountId: change.by,
      },
    });
  }
}
