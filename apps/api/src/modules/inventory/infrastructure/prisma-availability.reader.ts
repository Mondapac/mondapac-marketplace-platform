import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AvailabilityItem,
  AvailabilityReader,
} from '../application/ports/availability-reader';
import { heldQuantitiesOf } from './held-sum';

/**
 * {@link AvailabilityReader} on `inventory.stock_items` and the held sum of its reservation lines
 * (data design 4.3), through the Market-scoped client. Lock-free.
 */
export class PrismaAvailabilityReader implements AvailabilityReader {
  constructor(private readonly prisma: PrismaService) {}

  async itemsOfSellUnits(
    market: MarketContext,
    keys: readonly { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> }[],
    now: Temporal.Instant,
  ): Promise<readonly AvailabilityItem[]> {
    if (keys.length === 0) return [];
    const wanted = new Set(keys.map((key) => `${key.offerId}/${key.variantId}`));
    const rows = await this.prisma.tx(market).inventoryStockItem.findMany({
      where: {
        marketId: market.marketId,
        retiredAt: null,
        offerId: { in: [...new Set(keys.map((key) => key.offerId))] },
      },
      select: { id: true, offerId: true, variantId: true, onHand: true },
    });
    const items = rows.filter((row) => wanted.has(`${row.offerId}/${row.variantId}`));
    const held = await heldQuantitiesOf(
      this.prisma,
      market,
      items.map((row) => row.id as Id<'StockItem'>),
      now,
    );
    return items.map((row) => ({
      offerId: row.offerId as Id<'Offer'>,
      variantId: row.variantId as Id<'Variant'>,
      onHand: row.onHand,
      held: held.get(row.id as Id<'StockItem'>) ?? 0,
    }));
  }
}
