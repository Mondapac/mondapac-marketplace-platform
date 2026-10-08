import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SellerInventoryRepository } from '../application/ports/seller-inventory.repository';
import { SellerInventory, type InventorySourceState } from '../domain/seller-inventory';
import type { SourceAddress } from '../domain/source-text';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const fromDate = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const addressJson = (address: SourceAddress | null) =>
  address === null ? Prisma.DbNull : { ...address };

/**
 * {@link SellerInventoryRepository} on `inventory.seller_inventories` and `inventory.sources`
 * (data design 3.2, 3.3). Every statement goes through `PrismaService.tx(market)` with
 * `marketId` at the top level of `where`; writes are single statements, never nested. The
 * inventory is inserted first with `skipDuplicates`: a count of zero means the seller already
 * has one in the Market (the unique key, or a lost race), and nothing else is written.
 */
export class PrismaSellerInventoryRepository implements SellerInventoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(market: MarketContext, inventory: SellerInventory): Promise<boolean> {
    const state = inventory.state;
    const tx = this.prisma.tx(market);
    const { count } = await tx.inventorySellerInventory.createMany({
      data: [
        {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          sellerId: state.sellerId,
          lowStockThreshold: state.lowStockThreshold,
          version: state.version,
          createdAt: toDate(state.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return false;

    await tx.inventorySource.createMany({
      data: state.sources.map((source) => ({
        id: source.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        sellerId: state.sellerId,
        name: source.name,
        address: addressJson(source.address),
        timeZone: source.timeZone,
        isDefault: source.isDefault,
        priority: source.priority,
        createdAt: toDate(source.createdAt),
      })),
    });
    return true;
  }

  async findBySeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<SellerInventory | null> {
    const row = await this.prisma.tx(market).inventorySellerInventory.findFirst({
      where: { marketId: market.marketId, sellerId },
      include: { sources: { orderBy: { priority: 'asc' } } },
    });
    if (row === null) return null;
    return SellerInventory.fromStored({
      id: row.id as Id<'SellerInventory'>,
      sellerId: row.sellerId as Id<'Seller'>,
      marketId: market.marketId,
      lowStockThreshold: row.lowStockThreshold,
      version: row.version,
      createdAt: fromDate(row.createdAt),
      sources: row.sources.map((source): InventorySourceState =>
        Object.freeze({
          id: source.id as Id<'InventorySource'>,
          name: source.name,
          isDefault: source.isDefault,
          priority: source.priority,
          address: source.address === null ? null : (source.address as SourceAddress),
          timeZone: source.timeZone,
          createdAt: fromDate(source.createdAt),
        }),
      ),
    });
  }

  async save(market: MarketContext, inventory: SellerInventory): Promise<'saved' | 'stale'> {
    const state = inventory.state;
    const persisted = inventory.persistedVersion;
    if (persisted === null || inventory.changes.length === 0) {
      throw new Error('inventory.save: nothing loaded or nothing changed');
    }
    const tx = this.prisma.tx(market);
    // The root first: it is the lock and the version check of the whole aggregate (D 2.3).
    const { count } = await tx.inventorySellerInventory.updateMany({
      where: { id: state.id, marketId: market.marketId, version: persisted },
      data: { version: state.version },
    });
    if (count === 0) return 'stale';

    const byId = new Map(state.sources.map((source) => [source.id as string, source]));
    for (const change of inventory.changes) {
      if (change.kind === 'added') {
        const source = byId.get(change.sourceId)!;
        await tx.inventorySource.create({
          data: {
            id: source.id,
            marketId: market.marketId,
            tenantId: market.tenantId,
            sellerId: state.sellerId,
            name: source.name,
            address: addressJson(source.address),
            timeZone: source.timeZone,
            isDefault: false,
            priority: source.priority,
            createdAt: toDate(source.createdAt),
          },
        });
      } else if (change.kind === 'edited') {
        const source = byId.get(change.sourceId)!;
        await tx.inventorySource.updateMany({
          where: { id: source.id, marketId: market.marketId, sellerId: state.sellerId },
          data: {
            name: source.name,
            address: addressJson(source.address),
            timeZone: source.timeZone,
          },
        });
      } else {
        // Two passes against the non-deferrable unique key (data design T2, option A): park each
        // moved source at `n + position`, then settle it at `position`.
        const n = state.sources.length;
        for (const phase of ['park', 'settle'] as const) {
          for (const source of state.sources) {
            await tx.inventorySource.updateMany({
              where: { id: source.id, marketId: market.marketId, sellerId: state.sellerId },
              data: { priority: phase === 'park' ? n + source.priority : source.priority },
            });
          }
        }
      }
    }
    return 'saved';
  }
}
