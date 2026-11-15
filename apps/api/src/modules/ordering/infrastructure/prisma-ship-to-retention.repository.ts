import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  MarketZones,
  ShipToPurgeBatch,
  ShipToPurgeCursor,
  ShipToRetentionRepository,
} from '../application/ports/ship-to-retention.repository';
import type { ShipToRetention } from '../domain/ship-to-retention';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * {@link ShipToRetentionRepository} on `ordering.ship_to_retention_settings` and the ship-to column
 * of `ordering.orders` (the app role may update that one column, to null only by this code).
 */
export class PrismaShipToRetentionRepository implements ShipToRetentionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext): Promise<ShipToRetention | null> {
    const row = await this.prisma.tx(market).orderingShipToRetentionSetting.findFirst({
      where: { marketId: market.marketId },
    });
    return row === null
      ? null
      : {
          id: row.id as Id<'ShipToRetentionSetting'>,
          enabled: row.enabled,
          months: row.months,
          version: row.version,
          updatedAt: toInstant(row.updatedAt),
          updatedBy: row.updatedByAccountId as Id<'Account'>,
        };
  }

  async save(
    market: MarketContext,
    setting: ShipToRetention,
    expectedVersion: number,
  ): Promise<'saved' | 'stale'> {
    const tx = this.prisma.tx(market);
    const values = {
      enabled: setting.enabled,
      months: setting.months,
      updatedAt: toDate(setting.updatedAt),
      updatedByAccountId: setting.updatedBy,
    };
    if (expectedVersion === 0) {
      // ON CONFLICT DO NOTHING: a setting another admin made first (one row per Market) is `stale`.
      const made = await tx.orderingShipToRetentionSetting.createMany({
        data: [
          {
            id: setting.id,
            marketId: market.marketId,
            tenantId: market.tenantId,
            version: 1,
            ...values,
          },
        ],
        skipDuplicates: true,
      });
      return made.count === 1 ? 'saved' : 'stale';
    }
    const changed = await tx.orderingShipToRetentionSetting.updateMany({
      where: { marketId: market.marketId, version: expectedVersion },
      data: { ...values, version: expectedVersion + 1 },
    });
    return changed.count === 1 ? 'saved' : 'stale';
  }

  async clearDeliveredShipTo(
    market: MarketContext,
    cutoff: Temporal.Instant,
    after: ShipToPurgeCursor | null,
    limit: number,
  ): Promise<ShipToPurgeBatch> {
    const tx = this.prisma.tx(market);
    const until = toDate(cutoff);
    // The rule of `isShipToPurgeable`: at least one seller order, and every one delivered at or
    // before the cutoff (a null delivered_at fails `lte`). An order is delivered after it was
    // confirmed, so confirmed_at <= cutoff bounds the scan (partial index on uncleared orders).
    const rows = await tx.orderingOrder.findMany({
      where: {
        marketId: market.marketId,
        status: 'confirmed',
        shipToCiphertext: { not: null },
        confirmedAt: { lte: until },
        sellerOrders: { some: {}, every: { deliveredAt: { lte: until } } },
        ...(after === null
          ? {}
          : {
              OR: [
                { confirmedAt: { gt: toDate(after.confirmedAt) } },
                { confirmedAt: toDate(after.confirmedAt), id: { gt: after.orderId } },
              ],
            }),
      },
      orderBy: [{ confirmedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, confirmedAt: true },
    });
    if (rows.length === 0) return { cleared: 0, next: null };
    const changed = await tx.orderingOrder.updateMany({
      where: {
        marketId: market.marketId,
        id: { in: rows.map((row) => row.id) },
        shipToCiphertext: { not: null },
      },
      data: { shipToCiphertext: null },
    });
    const last = rows[rows.length - 1]!;
    return {
      cleared: changed.count,
      next:
        rows.length < limit || last.confirmedAt === null
          ? null
          : { confirmedAt: toInstant(last.confirmedAt), orderId: last.id },
    };
  }
}

/** {@link MarketZones} from the Market configuration's `timezone`. */
export class RegistryMarketZones implements MarketZones {
  constructor(private readonly markets: MarketRegistry) {}

  zoneOf(market: MarketContext): string {
    return this.markets.get(market.marketId).timezone;
  }
}
