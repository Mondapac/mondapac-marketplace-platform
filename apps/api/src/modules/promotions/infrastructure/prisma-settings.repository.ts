import type { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { FirstOrderSettings } from '../application/ports/promotions-policy';
import type {
  FirstOrderSettingsRepository,
  ShippingThresholdRecord,
  ShippingThresholdRepository,
} from '../application/ports/settings.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** {@link FirstOrderSettingsRepository} on `promotions.first_order_settings`, scoped by `marketId`. */
export class PrismaFirstOrderSettingsRepository implements FirstOrderSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext): Promise<FirstOrderSettings | null> {
    const row = await this.prisma
      .tx(market)
      .promotionsFirstOrderSetting.findFirst({ where: { marketId: market.marketId } });
    return row === null
      ? null
      : {
          enabled: row.enabled,
          kind: row.kind as 'PERCENT' | 'FIXED',
          percentBps: row.percentBps,
          amountMinor: row.amountMinor,
          capMinor: row.capMinor,
          minSpendMinor: row.minSpendMinor,
          monthlyBudgetMinor: row.monthlyBudgetMinor,
        };
  }

  async save(
    market: MarketContext,
    settings: FirstOrderSettings,
    at: Temporal.Instant,
    by: Id<'Account'>,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    const data = {
      enabled: settings.enabled,
      kind: settings.kind,
      percentBps: settings.percentBps,
      amountMinor: settings.amountMinor,
      capMinor: settings.capMinor,
      minSpendMinor: settings.minSpendMinor,
      monthlyBudgetMinor: settings.monthlyBudgetMinor,
      updatedAt: toDate(at),
      updatedByAccountId: by,
    };
    await tx.promotionsFirstOrderSetting.createMany({
      data: [{ ...data, marketId: market.marketId, tenantId: market.tenantId }],
      skipDuplicates: true,
    });
    await tx.promotionsFirstOrderSetting.updateMany({ where: { marketId: market.marketId }, data });
  }
}

/** {@link ShippingThresholdRepository} on `promotions.free_shipping_thresholds`, scoped by `marketId`. */
export class PrismaShippingThresholdRepository implements ShippingThresholdRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(market: MarketContext): Promise<readonly ShippingThresholdRecord[]> {
    const rows = await this.prisma.tx(market).promotionsFreeShippingThreshold.findMany({
      where: { marketId: market.marketId },
      orderBy: { zoneCode: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id as Id<'FreeShippingThreshold'>,
      zoneCode: row.zoneCode,
      thresholdMinor: row.thresholdMinor,
    }));
  }

  async find(market: MarketContext, zoneCode: string): Promise<ShippingThresholdRecord | null> {
    const row = await this.prisma.tx(market).promotionsFreeShippingThreshold.findFirst({
      where: { marketId: market.marketId, zoneCode },
    });
    return row === null
      ? null
      : {
          id: row.id as Id<'FreeShippingThreshold'>,
          zoneCode: row.zoneCode,
          thresholdMinor: row.thresholdMinor,
        };
  }

  async save(
    market: MarketContext,
    newId: Id<'FreeShippingThreshold'>,
    zoneCode: string,
    thresholdMinor: bigint,
    at: Temporal.Instant,
    by: Id<'Account'>,
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    const data = { thresholdMinor, updatedAt: toDate(at), updatedByAccountId: by };
    await tx.promotionsFreeShippingThreshold.createMany({
      data: [
        { ...data, id: newId, marketId: market.marketId, tenantId: market.tenantId, zoneCode },
      ],
      skipDuplicates: true,
    });
    await tx.promotionsFreeShippingThreshold.updateMany({
      where: { marketId: market.marketId, zoneCode },
      data,
    });
  }

  async remove(market: MarketContext, zoneCode: string): Promise<void> {
    await this.prisma.tx(market).promotionsFreeShippingThreshold.deleteMany({
      where: { marketId: market.marketId, zoneCode },
    });
  }
}
