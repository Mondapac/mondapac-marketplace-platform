import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SellerProductOwnersReader } from '../application/ports/seller-product-owners.reader';

/**
 * {@link SellerProductOwnersReader}: the requested products of the Market by `(market_id, id)`
 * (the unique key, so no scan), SELLER scope only. One statement, scoped by `market_id`.
 */
export class PrismaSellerProductOwnersReader implements SellerProductOwnersReader {
  constructor(private readonly prisma: PrismaService) {}

  async read(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<ReadonlyMap<Id<'Product'>, Id<'Seller'>>> {
    if (productIds.length === 0) return new Map();
    const rows = await this.prisma.tx(market).catalogProduct.findMany({
      where: { marketId: market.marketId, id: { in: [...productIds] }, scope: 'SELLER' },
      select: { id: true, ownerSellerId: true },
    });
    const owners = new Map<Id<'Product'>, Id<'Seller'>>();
    for (const row of rows) {
      if (row.ownerSellerId !== null) {
        owners.set(row.id as Id<'Product'>, row.ownerSellerId as Id<'Seller'>);
      }
    }
    return owners;
  }
}
