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
import type { Fulfilment, OrderStatus } from '../domain/order';
import type { RefundState } from '../domain/refund';
import { isShipToPurgeable, type ShipToRetention } from '../domain/ship-to-retention';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * {@link ShipToRetentionRepository} on `ordering.ship_to_retention_settings` and the ship-to column
 * of `ordering.orders` (the app role may update that one column, and the trigger
 * `orders_ship_to_clear_only` lets it only clear). Prisma only: the candidates come from a narrowing
 * query and the rule is decided by `isShipToPurgeable`.
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

  async clearSettledShipTo(
    market: MarketContext,
    cutoff: Temporal.Instant,
    after: ShipToPurgeCursor | null,
    limit: number,
  ): Promise<ShipToPurgeBatch> {
    const phase = after?.phase ?? 'confirmed';
    const tx = this.prisma.tx(market);
    const until = toDate(cutoff);
    const from =
      after === null || after.at === null || after.orderId === null
        ? null
        : { at: toDate(after.at), orderId: after.orderId };
    // The query only narrows the candidates (a superset of what `isShipToPurgeable` allows); the
    // rule itself is decided in code below, so it lives in one place. Each phase walks its own
    // partial index of orders that still hold a sealed ship-to, bounded by its own instant: every
    // settling instant of a confirmed order is after its confirmation, and a cancelled order is
    // settled at its cancellation.
    const time = phase === 'confirmed' ? 'confirmedAt' : 'cancelledAt';
    const rows = await tx.orderingOrder.findMany({
      where: {
        marketId: market.marketId,
        status: phase,
        shipToCiphertext: { not: null },
        [time]: { lte: until },
        sellerOrders:
          phase === 'cancelled'
            ? { some: {} }
            : {
                some: {},
                // `every` is NOT EXISTS (... WHERE NOT cond): each branch names its instant as
                // not null, since with SQL's null logic NOT (NULL <= x) is NULL and would let a
                // seller order through. The database spec holds every unsettled shape back.
                every: {
                  OR: [
                    { fulfilment: 'delivered', deliveredAt: { not: null, lte: until } },
                    { fulfilment: 'shipped', shippedAt: { not: null, lte: until } },
                    {
                      fulfilment: 'to-ship',
                      refunds: {
                        some: { state: 'succeeded', settledAt: { not: null, lte: until } },
                      },
                    },
                  ],
                },
              },
        ...(from === null
          ? {}
          : {
              OR: [{ [time]: { gt: from.at } }, { [time]: from.at, id: { gt: from.orderId } }],
            }),
      },
      orderBy: [{ [time]: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        status: true,
        confirmedAt: true,
        cancelledAt: true,
        sellerOrders: {
          select: {
            fulfilment: true,
            shippedAt: true,
            deliveredAt: true,
            lines: { select: { id: true, quantity: true } },
            refunds: {
              select: {
                state: true,
                settledAt: true,
                lines: { select: { orderLineId: true, quantity: true } },
              },
            },
          },
        },
      },
    });
    const purgeable = rows
      .filter((row) =>
        isShipToPurgeable(
          {
            status: row.status as OrderStatus,
            cancelledAt: row.cancelledAt === null ? null : toInstant(row.cancelledAt),
            sellerOrders: row.sellerOrders.map((so) => ({
              fulfilment: so.fulfilment as Fulfilment,
              shippedAt: so.shippedAt === null ? null : toInstant(so.shippedAt),
              deliveredAt: so.deliveredAt === null ? null : toInstant(so.deliveredAt),
              lines: so.lines.map((line) => ({
                lineId: line.id as Id<'OrderLine'>,
                quantity: line.quantity,
              })),
              refunds: so.refunds.map((refund) => ({
                state: refund.state as RefundState,
                settledAt: refund.settledAt === null ? null : toInstant(refund.settledAt),
                lines: refund.lines.map((line) => ({
                  orderLineId: line.orderLineId as Id<'OrderLine'>,
                  quantity: line.quantity,
                })),
              })),
            })),
          },
          cutoff,
        ),
      )
      .map((row) => row.id);
    const changed =
      purgeable.length === 0
        ? { count: 0 }
        : await tx.orderingOrder.updateMany({
            where: {
              marketId: market.marketId,
              id: { in: purgeable },
              shipToCiphertext: { not: null },
            },
            data: { shipToCiphertext: null },
          });
    const last = rows.at(-1);
    const lastAt = last === undefined ? null : last[time];
    const next: ShipToPurgeCursor | null =
      rows.length === limit && last !== undefined && lastAt !== null
        ? { phase, at: toInstant(lastAt), orderId: last.id }
        : phase === 'confirmed'
          ? { phase: 'cancelled', at: null, orderId: null }
          : null;
    return { cleared: changed.count, next };
  }
}

/** {@link MarketZones} from the Market configuration's `timezone`. */
export class RegistryMarketZones implements MarketZones {
  constructor(private readonly markets: MarketRegistry) {}

  zoneOf(market: MarketContext): string {
    return this.markets.get(market.marketId).timezone;
  }
}
