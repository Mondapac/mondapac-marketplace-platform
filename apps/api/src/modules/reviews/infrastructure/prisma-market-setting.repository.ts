import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  MarketSettingRecord,
  MarketSettingRepository,
} from '../application/ports/market-setting.repository';
import type { ReviewsStatus } from '../domain/market-status';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** {@link MarketSettingRepository} on `reviews.market_settings`, scoped by `marketId`. */
export class PrismaMarketSettingRepository implements MarketSettingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext): Promise<MarketSettingRecord | null> {
    const row = await this.prisma
      .tx(market)
      .reviewsMarketSetting.findFirst({ where: { marketId: market.marketId } });
    return row === null
      ? null
      : {
          status: row.status as ReviewsStatus,
          updatedAt: Temporal.Instant.fromEpochMilliseconds(row.updatedAt.getTime()),
          updatedBy: row.updatedByAccountId as Id<'Account'>,
        };
  }

  async save(market: MarketContext, record: MarketSettingRecord): Promise<void> {
    const tx = this.prisma.tx(market);
    const data = {
      status: record.status,
      updatedAt: toDate(record.updatedAt),
      updatedByAccountId: record.updatedBy,
    };
    // The insert loses quietly to a concurrent first write; the update then sets the asked state.
    await tx.reviewsMarketSetting.createMany({
      data: [{ ...data, marketId: market.marketId, tenantId: market.tenantId }],
      skipDuplicates: true,
    });
    await tx.reviewsMarketSetting.updateMany({ where: { marketId: market.marketId }, data });
  }
}
