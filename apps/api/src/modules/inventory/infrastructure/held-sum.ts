import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';

/** Prisma's `where` shape below is a contract: the plan depends on it (data design 4.3). */
const MAX_IN_LIST = 1000;

/**
 * The held sum of data design 4.3 (toss-up T1, option A): per stock item, the quantity of lines
 * ACTIVE and not yet expired at `now`, plus COMMITTED lines. `state IN (...)` is mandatory: it
 * becomes the index condition of the held index, so the cost does not grow with history. `now` is
 * the Clock instant, never the database's (ADR-0005). Items with nothing held answer 0.
 */
export async function heldQuantitiesOf(
  prisma: PrismaService,
  market: MarketContext,
  stockItemIds: readonly Id<'StockItem'>[],
  now: Temporal.Instant,
): Promise<ReadonlyMap<Id<'StockItem'>, number>> {
  const held = new Map<Id<'StockItem'>, number>(stockItemIds.map((id) => [id, 0] as const));
  const unique = [...new Set(stockItemIds)];
  for (let at = 0; at < unique.length; at += MAX_IN_LIST) {
    const rows = await prisma.tx(market).inventoryReservationLine.groupBy({
      by: ['stockItemId', 'state'],
      _sum: { quantity: true },
      where: {
        marketId: market.marketId,
        stockItemId: { in: unique.slice(at, at + MAX_IN_LIST) },
        state: { in: ['active', 'committed'] },
        OR: [{ state: 'committed' }, { expiresAt: { gt: new Date(now.epochMilliseconds) } }],
      },
    });
    for (const row of rows) {
      const id = row.stockItemId as Id<'StockItem'>;
      held.set(id, (held.get(id) ?? 0) + (row._sum.quantity ?? 0));
    }
  }
  return held;
}
