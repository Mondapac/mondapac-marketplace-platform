import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SellerInventoryRepository } from '../application/ports/seller-inventory.repository';
import type { SellerInventory } from '../domain/seller-inventory';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

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
        isDefault: source.isDefault,
        priority: source.priority,
        createdAt: toDate(source.createdAt),
      })),
    });
    return true;
  }
}
