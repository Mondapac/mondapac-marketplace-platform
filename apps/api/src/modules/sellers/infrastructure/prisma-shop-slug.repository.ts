import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ShopSlugHolder,
  ShopSlugRepository,
  SlugHoldOutcome,
} from '../application/ports/shop-slug.repository';
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

  async hold(
    market: MarketContext,
    input: {
      readonly id: Id;
      readonly sellerId: Id<'Seller'>;
      readonly slug: ShopSlug;
      readonly now: Temporal.Instant;
    },
  ): Promise<SlugHoldOutcome> {
    const tx = this.prisma.tx(market);
    const at = new Date(input.now.epochMilliseconds);
    // `ON CONFLICT DO NOTHING` covers both unique keys (the slug in the Market, one held slug per
    // seller), so a lost race writes nothing and the unit's transaction stays usable.
    const { count } = await tx.sellersShopSlug.createMany({
      data: [
        {
          id: input.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          slug: input.slug,
          sellerId: input.sellerId,
          state: 'held',
          everPublic: false,
          heldAt: at,
          version: 1,
          createdAt: at,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 1) return 'held';
    const holder = await this.findBySlug(market, input.slug);
    if (holder === null) {
      // Nobody has the slug, yet nothing was inserted: the seller holds another slug (I-S1).
      throw new Error('sellers.shop_slugs: the seller already holds another slug');
    }
    return holder.state === 'held' && holder.sellerId === input.sellerId ? 'already-held' : 'taken';
  }

  async releaseUnpublished(market: MarketContext, sellerId: Id<'Seller'>): Promise<number> {
    const { count } = await this.prisma.tx(market).sellersShopSlug.deleteMany({
      where: { marketId: market.marketId, sellerId, state: 'held', everPublic: false },
    });
    return count;
  }
}
