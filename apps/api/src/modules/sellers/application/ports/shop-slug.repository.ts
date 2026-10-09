import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ShopSlug } from '../../domain/shop-slug';

/** The row of a slug in the Market: who holds or held it, and whether it is retired. */
export interface ShopSlugHolder {
  readonly sellerId: Id<'Seller'>;
  readonly state: 'held' | 'retired';
}

/** What holding a slug did (sellers design 3.5; data design 3.5). */
export type SlugHoldOutcome = 'held' | 'already-held' | 'taken';

/**
 * The store of shop slugs (sellers design 3.5; data design 3.5). Runs in the open unit of the
 * use case. A draft slug is not held (T1): the first submission holds it, and the unique key
 * `(market_id, slug)` decides a race then, never a read before it.
 */
export interface ShopSlugRepository {
  /** The row of this slug in the Market, retired rows included, or null. */
  findBySlug(market: MarketContext, slug: ShopSlug): Promise<ShopSlugHolder | null>;

  /**
   * Holds the slug for the seller (the first submission, T1). One insert that does nothing on a
   * conflict (so a lost race leaves the unit usable): `held` when the row was inserted,
   * `already-held` when this seller already holds this very slug (a later submission), `taken`
   * when another seller holds it or anyone retired it. A seller that holds another slug already
   * (invariant I-S1 broken) is a fault and throws; nothing is written then.
   */
  hold(
    market: MarketContext,
    input: {
      readonly id: Id;
      readonly sellerId: Id<'Seller'>;
      readonly slug: ShopSlug;
      readonly now: Temporal.Instant;
    },
  ): Promise<SlugHoldOutcome>;

  /**
   * Releases the seller's held slug that was never public (the draft slug changed before
   * approval, data design 3.5, Q-M21). Answers how many rows went (0 or 1). A retired or
   * ever-public row is never touched (the database refuses it as well).
   */
  releaseUnpublished(market: MarketContext, sellerId: Id<'Seller'>): Promise<number>;
}

export const SHOP_SLUG_REPOSITORY = Symbol('SHOP_SLUG_REPOSITORY');
