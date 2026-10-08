import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { ShopSlug } from '../../domain/shop-slug';

/** The row of a slug in the Market: who holds or held it, and whether it is retired. */
export interface ShopSlugHolder {
  readonly sellerId: Id<'Seller'>;
  readonly state: 'held' | 'retired';
}

/**
 * The store of shop slugs (sellers design 3.5; data design 3.5). Runs in the open unit of the
 * use case. Slice 2 only reads: a draft slug is not held (T1), the first submission holds it
 * (slice 5), and the unique key `(market_id, slug)` decides a race then, never this read.
 */
export interface ShopSlugRepository {
  /** The row of this slug in the Market, retired rows included, or null. */
  findBySlug(market: MarketContext, slug: ShopSlug): Promise<ShopSlugHolder | null>;
}

export const SHOP_SLUG_REPOSITORY = Symbol('SHOP_SLUG_REPOSITORY');
