import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  MarketSettingRecord,
  MarketSettingRepository,
} from '../application/ports/market-setting.repository';
import type { WalletStatus, WalletStatusReason } from '../domain/wallet-status';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** The updater of the row `findForUpdate` seeds as `off`; such a row means "never set". */
const SEED_UPDATER = '00000000-0000-0000-0000-000000000000';

const toRecord = (row: {
  readonly status: string;
  readonly reasonCode: string | null;
  readonly updatedAt: Date;
  readonly updatedByAccountId: string;
  readonly version: number;
}): MarketSettingRecord => ({
  status: row.status as WalletStatus,
  reason: row.reasonCode as WalletStatusReason | null,
  updatedAt: Temporal.Instant.fromEpochMilliseconds(row.updatedAt.getTime()),
  updatedBy: row.updatedByAccountId as Id<'Account'>,
  version: row.version,
});

/** {@link MarketSettingRepository} on `wallet.market_settings`, scoped by `marketId`. */
export class PrismaMarketSettingRepository implements MarketSettingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext) {
    const row = await this.prisma
      .tx(market)
      .walletMarketSetting.findFirst({ where: { marketId: market.marketId } });
    return row === null || row.updatedByAccountId === SEED_UPDATER ? null : toRecord(row);
  }

  async findForUpdate(market: MarketContext) {
    // The row is seeded as `off` (ON CONFLICT DO NOTHING) so that there is always one to lock; a
    // no-change update then takes the row lock until the unit ends, and the read after it sees
    // what was committed before the lock was granted. Two first PUTs queue on the lock.
    const tx = this.prisma.tx(market);
    await tx.walletMarketSetting.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          status: 'off',
          reasonCode: null,
          updatedAt: new Date(0),
          updatedByAccountId: SEED_UPDATER,
        },
      ],
      skipDuplicates: true,
    });
    const seen = await tx.walletMarketSetting.findFirstOrThrow({
      where: { marketId: market.marketId },
    });
    await tx.walletMarketSetting.updateMany({
      where: { marketId: market.marketId },
      data: { updatedAt: seen.updatedAt },
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
      // The caller holds the row lock (findForUpdate) and passes the next version.
      version: record.version,
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
