import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AvailabilityItem,
  AvailabilityReader,
} from '../application/ports/availability-reader';

/** {@link AvailabilityReader} on `inventory.stock_items`, through the Market-scoped client. */
export class PrismaAvailabilityReader implements AvailabilityReader {
  constructor(private readonly prisma: PrismaService) {}

  async itemsOfSellUnits(
    market: MarketContext,
    keys: readonly { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> }[],
  ): Promise<readonly AvailabilityItem[]> {
    if (keys.length === 0) return [];
    const wanted = new Set(keys.map((key) => `${key.offerId}/${key.variantId}`));
    const rows = await this.prisma.tx(market).inventoryStockItem.findMany({
      where: {
        marketId: market.marketId,
        retiredAt: null,
        offerId: { in: [...new Set(keys.map((key) => key.offerId))] },
      },
      select: { offerId: true, variantId: true, onHand: true },
    });
    return rows
      .filter((row) => wanted.has(`${row.offerId}/${row.variantId}`))
      .map((row) => ({
        offerId: row.offerId as Id<'Offer'>,
        variantId: row.variantId as Id<'Variant'>,
        onHand: row.onHand,
        held: 0,
      }));
  }
}
