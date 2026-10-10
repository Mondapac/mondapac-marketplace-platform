import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { OfferStockReader, OfferStockSnapshot } from '../application/ports/offer-stock.reader';
import { heldQuantitiesOf } from './held-sum';
import { PrismaStockRepository } from './prisma-stock.repository';

/** {@link OfferStockReader} on `inventory.stock_items`; every statement carries `marketId`. */
export class PrismaOfferStockReader implements OfferStockReader {
  readonly #stock: PrismaStockRepository;

  constructor(private readonly prisma: PrismaService) {
    this.#stock = new PrismaStockRepository(prisma);
  }

  async read(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    offerId: Id<'Offer'>,
    variantIds: readonly Id<'Variant'>[],
    now: Temporal.Instant,
  ): Promise<OfferStockSnapshot> {
    const tombstones = await this.#stock.tombstonesOf(market, offerId, variantIds);
    const rows = await this.prisma.tx(market).inventoryStockItem.findMany({
      where: { marketId: market.marketId, offerId, sellerId, variantId: { in: [...variantIds] } },
      select: {
        id: true,
        variantId: true,
        sourceId: true,
        onHand: true,
        version: true,
        retiredAt: true,
      },
      orderBy: { id: 'asc' },
    });
    const held = await heldQuantitiesOf(
      this.prisma,
      market,
      rows.map((row) => row.id as Id<'StockItem'>),
      now,
    );
    return {
      offerRetired: tombstones.offerRetired,
      retiredVariantIds: tombstones.retiredVariantIds,
      items: rows.map((row) => ({
        id: row.id as Id<'StockItem'>,
        variantId: row.variantId as Id<'Variant'>,
        sourceId: row.sourceId as Id<'InventorySource'>,
        onHand: row.onHand,
        version: row.version,
        retired: row.retiredAt !== null,
        held: held.get(row.id as Id<'StockItem'>) ?? 0,
      })),
    };
  }
}
