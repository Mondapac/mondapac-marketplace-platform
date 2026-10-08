import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { ShopSlugHolder, ShopSlugRepository } from '../application/ports/shop-slug.repository';
import type { ShopSlug } from '../domain/shop-slug';

/**
 * {@link ShopSlugRepository} on `sellers.shop_slugs` (data design 3.5): one read on the unique
 * key `(market_id, slug)`, retired rows included. The slug column is `COLLATE "C"`, so the
 * compare is byte-exact on the normalised slug.
 */
export class PrismaShopSlugRepository implements ShopSlugRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findBySlug(market: MarketContext, slug: ShopSlug): Promise<ShopSlugHolder | null> {
    const row = await this.prisma.tx(market).sellersShopSlug.findFirst({
      where: { marketId: market.marketId, slug },
      select: { sellerId: true, state: true },
    });
    if (row === null) return null;
    if (row.state !== 'held' && row.state !== 'retired') {
      throw new Error('sellers.shop_slugs holds an invalid state');
    }
    return { sellerId: row.sellerId as Id<'Seller'>, state: row.state };
  }
}
