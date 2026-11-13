import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AiAccessSettingRepository,
  AiAccessSettingState,
  AiAccessSettingView,
} from '../application/ports/ai-access-setting.repository';

/** {@link AiAccessSettingRepository} on `sellers.seller_admin_settings`, by Market. */
export class PrismaAiAccessSettingRepository implements AiAccessSettingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async lock(market: MarketContext, sellerId: Id<'Seller'>): Promise<AiAccessSettingState | null> {
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
      select: { aiEnabled: true, version: true },
    });
    return row === null ? null : { enabled: row.aiEnabled, version: row.version };
  }

  async set(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: {
      readonly enabled: boolean;
      readonly by: Id<'Account'>;
      readonly at: Temporal.Instant;
    },
  ): Promise<void> {
    await this.prisma.tx(market).sellersSellerAdminSettings.updateMany({
      where: { marketId: market.marketId, sellerId },
      data: {
        aiEnabled: change.enabled,
        aiEnabledChangedAt: new Date(change.at.epochMilliseconds),
        aiEnabledChangedByAccountId: change.by,
      },
    });
  }

  async read(market: MarketContext, sellerId: Id<'Seller'>): Promise<AiAccessSettingView | null> {
    const row = await this.prisma.tx(market).sellersSellerAdminSettings.findFirst({
      where: { marketId: market.marketId, sellerId },
      select: { aiEnabled: true, aiEnabledChangedAt: true },
    });
    if (row === null) return null;
    return {
      enabled: row.aiEnabled,
      changedAt:
        row.aiEnabledChangedAt === null
          ? null
          : Temporal.Instant.fromEpochMilliseconds(row.aiEnabledChangedAt.getTime()),
    };
  }
}
