import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  NewStockItem,
  NewStockMovement,
  StockItemRow,
  StockRepository,
} from '../application/ports/stock.repository';
import { assertSerializableUnit } from '../application/serializable-unit';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link StockRepository} on `inventory.stock_items`, `inventory.stock_movements` and
 * `inventory.retirements` (data design 3.4, 3.5, 3.10, 4.4). Every statement goes through
 * `PrismaService.tx(market)` with `marketId` at the top level of `where`, except the lock, which
 * is the named statement `inventory.lock-stock-items`. The writers run only in a serializable
 * unit (4.5) and fail closed elsewhere.
 */
export class PrismaStockRepository implements StockRepository {
  constructor(private readonly prisma: PrismaService) {}

  async lockSellUnit(
    market: MarketContext,
    offerId: Id<'Offer'>,
    variantId: Id<'Variant'>,
  ): Promise<readonly StockItemRow[]> {
    const found = await this.prisma.tx(market).inventoryStockItem.findMany({
      where: { marketId: market.marketId, offerId, variantId },
      select: { id: true },
    });
    if (found.length === 0) return [];
    const locked = await this.prisma.namedQuery(market, 'inventory.lock-stock-items', {
      ids: found.map((row) => row.id),
    });
    return locked.map((row) => ({
      id: row.id as Id<'StockItem'>,
      offerId: row.offerId as Id<'Offer'>,
      variantId: row.variantId as Id<'Variant'>,
      sourceId: row.sourceId as Id<'InventorySource'>,
      sellerId: row.sellerId as Id<'Seller'>,
      onHand: row.onHand,
      retired: row.retiredAt !== null,
      version: row.version,
    }));
  }

  async isSellUnitRetired(
    market: MarketContext,
    offerId: Id<'Offer'>,
    variantId: Id<'Variant'>,
  ): Promise<boolean> {
    const found = await this.prisma.tx(market).inventoryRetirement.findFirst({
      where: {
        marketId: market.marketId,
        offerId,
        OR: [{ scope: 'offer' }, { scope: 'variant', variantId }],
      },
      select: { id: true },
    });
    return found !== null;
  }

  heldQuantities(
    _market: MarketContext,
    stockItemIds: readonly Id<'StockItem'>[],
  ): Promise<ReadonlyMap<Id<'StockItem'>, number>> {
    // No reservation table exists before slice 4, so nothing can be held (see the port).
    return Promise.resolve(new Map(stockItemIds.map((id) => [id, 0] as const)));
  }

  async insertItem(market: MarketContext, item: NewStockItem): Promise<void> {
    assertSerializableUnit('StockRepository.insertItem');
    const { count } = await this.prisma.tx(market).inventoryStockItem.createMany({
      data: [
        {
          id: item.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          offerId: item.offerId,
          variantId: item.variantId,
          sourceId: item.sourceId,
          sellerId: item.sellerId,
          onHand: item.onHand,
          version: 1,
          createdAt: toDate(item.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    // The lock found no item of this key, so a duplicate needs a bug or a lost race that the
    // serializable unit should have refused with 40001.
    if (count === 0) throw new Error('inventory: the stock item to insert already exists');
  }

  async setOnHand(
    market: MarketContext,
    id: Id<'StockItem'>,
    expectedVersion: number,
    onHand: number,
  ): Promise<'saved' | 'stale'> {
    assertSerializableUnit('StockRepository.setOnHand');
    const { count } = await this.prisma.tx(market).inventoryStockItem.updateMany({
      where: { marketId: market.marketId, id, version: expectedVersion, retiredAt: null },
      data: { onHand, version: expectedVersion + 1 },
    });
    return count === 1 ? 'saved' : 'stale';
  }

  async appendMovement(market: MarketContext, movement: NewStockMovement): Promise<void> {
    await this.prisma.tx(market).inventoryStockMovement.createMany({
      data: [
        {
          id: movement.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          stockItemId: movement.stockItemId,
          offerId: movement.offerId,
          variantId: movement.variantId,
          delta: movement.delta,
          resultingOnHand: movement.resultingOnHand,
          reason: movement.reason,
          actorKind: 'account',
          actorAccountId: movement.actorAccountId,
          actorModule: null,
          correlationId: movement.correlationId,
          occurredAt: toDate(movement.occurredAt),
        },
      ],
    });
  }
}
