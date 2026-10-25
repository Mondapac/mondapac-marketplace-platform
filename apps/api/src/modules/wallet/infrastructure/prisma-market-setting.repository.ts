import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  MarketSettingRecord,
  MarketSettingRepository,
} from '../application/ports/market-setting.repository';
import type { WalletStatus, WalletStatusReason } from '../domain/wallet-status';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

const toRecord = (row: {
  readonly status: string;
  readonly reasonCode: string | null;
  readonly updatedAt: Date;
  readonly updatedByAccountId: string;
}): MarketSettingRecord => ({
  status: row.status as WalletStatus,
  reason: row.reasonCode as WalletStatusReason | null,
  updatedAt: Temporal.Instant.fromEpochMilliseconds(row.updatedAt.getTime()),
  updatedBy: row.updatedByAccountId as Id<'Account'>,
});

/** {@link MarketSettingRepository} on `wallet.market_settings`, scoped by `marketId`. */
export class PrismaMarketSettingRepository implements MarketSettingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext) {
    const row = await this.prisma
      .tx(market)
      .walletMarketSetting.findFirst({ where: { marketId: market.marketId } });
    return row === null ? null : toRecord(row);
  }

  async findForUpdate(market: MarketContext) {
    // A no-change update takes the row lock until the unit ends; the read after it sees what was
    // committed before the lock was granted.
    const tx = this.prisma.tx(market);
    const seen = await this.find(market);
    if (seen === null) return null;
    await tx.walletMarketSetting.updateMany({
      where: { marketId: market.marketId },
      data: { updatedAt: toDate(seen.updatedAt) },
    });
    return this.find(market);
  }

  async save(market: MarketContext, record: MarketSettingRecord): Promise<void> {
    const tx = this.prisma.tx(market);
    const data = {
      status: record.status,
      reasonCode: record.reason,
      updatedAt: toDate(record.updatedAt),
      updatedByAccountId: record.updatedBy,
    };
    const updated = await tx.walletMarketSetting.updateMany({
      where: { marketId: market.marketId },
      data,
    });
    if (updated.count === 0) {
      await tx.walletMarketSetting.create({
        data: { ...data, marketId: market.marketId, tenantId: market.tenantId },
      });
    }
  }
}
