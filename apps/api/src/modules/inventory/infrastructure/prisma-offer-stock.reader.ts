import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  LowStockPage,
  LowStockSignal,
  OfferStockReader,
  OfferStockSnapshot,
} from '../application/ports/offer-stock.reader';
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

  async listLowStock(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    status: 'low' | 'out' | null,
    page: LowStockPage,
  ): Promise<readonly LowStockSignal[]> {
    const after = page.after;
    const at = after === null ? null : new Date(after.changedAt.epochMilliseconds);
    const rows = await this.prisma.tx(market).inventoryAvailabilitySignal.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        status: status === null ? { in: ['low', 'out'] } : status,
        ...(after === null || at === null
          ? {}
          : { OR: [{ changedAt: { lt: at } }, { changedAt: at, id: { lt: after.id } }] }),
      },
      select: {
        id: true,
        offerId: true,
        variantId: true,
        status: true,
        onlyLeft: true,
        changedAt: true,
      },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: page.limit,
    });
    return rows.map((row) => ({
      id: row.id as Id<'AvailabilitySignal'>,
      offerId: row.offerId as Id<'Offer'>,
      variantId: row.variantId as Id<'Variant'>,
      status: row.status as 'low' | 'out',
      onlyLeft: row.onlyLeft,
      changedAt: Temporal.Instant.fromEpochMilliseconds(row.changedAt.getTime()),
    }));
  }

  async liveSellUnits(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    keys: readonly { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> }[],
  ): Promise<ReadonlySet<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.prisma.tx(market).inventoryStockItem.findMany({
      where: {
        marketId: market.marketId,
        sellerId,
        retiredAt: null,
        OR: keys.map((key) => ({ offerId: key.offerId, variantId: key.variantId })),
      },
      select: { offerId: true, variantId: true },
    });
    return new Set(rows.map((row) => `${row.offerId}:${row.variantId}`));
  }
}
