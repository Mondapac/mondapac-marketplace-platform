import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  NewRetirementTombstone,
  NewStockItem,
  NewStockMovement,
  OfferTombstones,
  StockItemRow,
  RetirementTarget,
  StockRepository,
} from '../application/ports/stock.repository';
import { assertSerializableUnit } from '../application/serializable-unit';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * The most items one `inventory.lock-stock-items` call locks (data design 4.3): the statement
 * refuses more, so a longer list is locked in consecutive ascending batches. A module may not
 * import the persistence internals, hence the copy; the 1,001-item case of
 * `inventory-retire-sell-units.db-spec.ts` fails if the platform cap ever drops below it.
 */
const MAX_LOCKED_STOCK_ITEMS = 1000;

/** The columns the lock statement answers (platform `LockedStockItem`). */
interface LockedRow {
  readonly id: string;
  readonly offerId: string;
  readonly variantId: string;
  readonly sourceId: string;
  readonly sellerId: string;
  readonly onHand: number;
  readonly retiredAt: Date | null;
  readonly version: number;
}

function toStockItemRow(row: LockedRow): StockItemRow {
  return {
    id: row.id as Id<'StockItem'>,
    offerId: row.offerId as Id<'Offer'>,
    variantId: row.variantId as Id<'Variant'>,
    sourceId: row.sourceId as Id<'InventorySource'>,
    sellerId: row.sellerId as Id<'Seller'>,
    onHand: row.onHand,
    retired: row.retiredAt !== null,
    version: row.version,
  };
}

/** Consecutive slices of at most `size`, in order. */
function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

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
    return locked.map(toStockItemRow);
  }

  async isSellUnitRetired(
    market: MarketContext,
    offerId: Id<'Offer'>,
    variantId: Id<'Variant'>,
  ): Promise<boolean> {
    const found = await this.prisma.tx(market).inventoryRetirement.findFirst({
      where: {
        marketId: market.marketId,
        // An Offer tombstone is keyed by the Offer, a Variant tombstone by the Variant alone
        // (data design 3.10, migration 3).
        OR: [
          { scope: 'offer', offerId },
          { scope: 'variant', variantId },
        ],
      },
      select: { id: true },
    });
    return found !== null;
  }

  async activeItemIds(
    market: MarketContext,
    target: RetirementTarget,
  ): Promise<readonly Id<'StockItem'>[]> {
    const rows = await this.prisma.tx(market).inventoryStockItem.findMany({
      where: {
        marketId: market.marketId,
        retiredAt: null,
        ...(target.scope === 'offer'
          ? { offerId: target.offerId }
          : { variantId: target.variantId }),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => row.id as Id<'StockItem'>);
  }

  async itemIdsOfOfferVariants(
    market: MarketContext,
    offerId: Id<'Offer'>,
    variantIds: readonly Id<'Variant'>[],
  ): Promise<readonly Id<'StockItem'>[]> {
    const rows = await this.prisma.tx(market).inventoryStockItem.findMany({
      where: { marketId: market.marketId, offerId, variantId: { in: [...variantIds] } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((row) => row.id as Id<'StockItem'>);
  }

  async tombstonesOf(
    market: MarketContext,
    offerId: Id<'Offer'>,
    variantIds: readonly Id<'Variant'>[],
  ): Promise<OfferTombstones> {
    const rows = await this.prisma.tx(market).inventoryRetirement.findMany({
      where: {
        marketId: market.marketId,
        OR: [
          { scope: 'offer', offerId },
          { scope: 'variant', variantId: { in: [...variantIds] } },
        ],
      },
      select: { scope: true, variantId: true },
    });
    return {
      offerRetired: rows.some((row) => row.scope === 'offer'),
      retiredVariantIds: new Set(
        rows.flatMap((row) =>
          row.scope === 'variant' && row.variantId !== null ? [row.variantId as Id<'Variant'>] : [],
        ),
      ),
    };
  }

  async lockItems(
    market: MarketContext,
    ids: readonly Id<'StockItem'>[],
  ): Promise<readonly StockItemRow[]> {
    assertSerializableUnit('StockRepository.lockItems');
    const rows: StockItemRow[] = [];
    // Ascending ids in ascending batches keep one global lock order (data design 4.4).
    for (const batch of batches([...ids].sort(), MAX_LOCKED_STOCK_ITEMS)) {
      const locked = await this.prisma.namedQuery(market, 'inventory.lock-stock-items', {
        ids: batch,
      });
      rows.push(...locked.map(toStockItemRow));
    }
    return rows;
  }

  async recordTombstone(market: MarketContext, tombstone: NewRetirementTombstone): Promise<void> {
    assertSerializableUnit('StockRepository.recordTombstone');
    const { target } = tombstone;
    // `skipDuplicates` is ON CONFLICT DO NOTHING without a target, which covers both partial
    // unique indexes; a replay or an event that arrives twice keeps the first tombstone.
    await this.prisma.tx(market).inventoryRetirement.createMany({
      data: [
        {
          id: tombstone.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          scope: target.scope,
          offerId: target.scope === 'offer' ? target.offerId : null,
          variantId: target.scope === 'variant' ? target.variantId : null,
          sourceAggregateVersion: tombstone.sourceAggregateVersion,
          retiredAt: toDate(tombstone.retiredAt),
        },
      ],
      skipDuplicates: true,
    });
  }

  async retireItems(
    market: MarketContext,
    ids: readonly Id<'StockItem'>[],
    retiredAt: Temporal.Instant,
  ): Promise<number> {
    assertSerializableUnit('StockRepository.retireItems');
    let changed = 0;
    for (const batch of batches(ids, MAX_LOCKED_STOCK_ITEMS)) {
      // `retiredAt: null` keeps it one way: a retired item keeps its first instant (M6).
      const { count } = await this.prisma.tx(market).inventoryStockItem.updateMany({
        where: { marketId: market.marketId, id: { in: batch }, retiredAt: null },
        data: { retiredAt: toDate(retiredAt) },
      });
      changed += count;
    }
    return changed;
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
          // `re-key` is the module's own write (the table CHECK pairs reason and actor kind).
          ...(movement.reason === 're-key'
            ? { actorKind: 'module', actorAccountId: null, actorModule: 'inventory' }
            : {
                actorKind: 'account',
                actorAccountId: movement.actorAccountId,
                actorModule: null,
              }),
          correlationId: movement.correlationId,
          occurredAt: toDate(movement.occurredAt),
        },
      ],
    });
  }
}
