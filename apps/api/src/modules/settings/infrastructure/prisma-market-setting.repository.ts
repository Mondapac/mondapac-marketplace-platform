import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  MarketSettingChange,
  MarketSettingHistoryRecord,
  MarketSettingRecord,
  MarketSettingRepository,
} from '../application/ports/market-setting.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

interface Row {
  readonly code: string;
  readonly value: string;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedByAccountId: string;
}

const toRecord = (row: Row): MarketSettingRecord => ({
  code: row.code,
  value: row.value,
  version: row.version,
  updatedAt: Temporal.Instant.fromEpochMilliseconds(row.updatedAt.getTime()),
  updatedBy: row.updatedByAccountId as Id<'Account'>,
});

interface HistoryRow {
  readonly code: string;
  readonly version: number;
  readonly previousValue: string | null;
  readonly value: string;
  readonly changedAt: Date;
  readonly changedByAccountId: string;
  readonly note: string | null;
}

const toHistory = (row: HistoryRow): MarketSettingHistoryRecord => ({
  code: row.code,
  version: row.version,
  previousValue: row.previousValue,
  value: row.value,
  changedAt: Temporal.Instant.fromEpochMilliseconds(row.changedAt.getTime()),
  changedBy: row.changedByAccountId as Id<'Account'>,
  note: row.note,
});

/** {@link MarketSettingRepository} on `settings.market_settings`, scoped by `marketId`. */
export class PrismaMarketSettingRepository implements MarketSettingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(market: MarketContext): Promise<readonly MarketSettingRecord[]> {
    const rows = await this.prisma
      .tx(market)
      .settingsMarketSetting.findMany({ where: { marketId: market.marketId } });
    return rows.map(toRecord);
  }

  async find(market: MarketContext, code: string): Promise<MarketSettingRecord | null> {
    const row = await this.prisma
      .tx(market)
      .settingsMarketSetting.findFirst({ where: { marketId: market.marketId, code } });
    return row === null ? null : toRecord(row);
  }

  async apply(market: MarketContext, change: MarketSettingChange): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const changedAt = toDate(change.changedAt);
    if (change.version === 1) {
      // The first write: the primary key refuses a second admin's first write.
      const created = await tx.settingsMarketSetting.createMany({
        data: [
          {
            marketId: market.marketId,
            tenantId: market.tenantId,
            code: change.code,
            value: change.value,
            version: 1,
            updatedAt: changedAt,
            updatedByAccountId: change.changedBy,
          },
        ],
        skipDuplicates: true,
      });
      if (created.count === 0) return false;
    } else {
      const updated = await tx.settingsMarketSetting.updateMany({
        where: { marketId: market.marketId, code: change.code, version: change.version - 1 },
        data: {
          value: change.value,
          version: change.version,
          updatedAt: changedAt,
          updatedByAccountId: change.changedBy,
        },
      });
      if (updated.count === 0) return false;
    }
    await tx.settingsMarketSettingHistory.create({
      data: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        code: change.code,
        version: change.version,
        previousValue: change.previousValue,
        value: change.value,
        changedAt,
        changedByAccountId: change.changedBy,
        note: change.note,
      },
    });
    return true;
  }

  async history(
    market: MarketContext,
    code: string,
    limit: number,
  ): Promise<readonly MarketSettingHistoryRecord[]> {
    // The primary key (market_id, code, version) serves the filter and the order.
    const rows = await this.prisma.tx(market).settingsMarketSettingHistory.findMany({
      where: { marketId: market.marketId, code },
      orderBy: { version: 'desc' },
      take: limit,
    });
    return rows.map(toHistory);
  }

  async historyVersion(
    market: MarketContext,
    code: string,
    version: number,
  ): Promise<MarketSettingHistoryRecord | null> {
    const row = await this.prisma.tx(market).settingsMarketSettingHistory.findFirst({
      where: { marketId: market.marketId, code, version },
    });
    return row === null ? null : toHistory(row);
  }
}
