import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  SellerReviewStanding,
  SellerReviewStandingState,
} from '../../domain/seller-review-standing';

/** One probation credit: an admin approval of a first publication (once per product per epoch). */
export interface SellerReviewCredit {
  readonly sellerId: Id<'Seller'>;
  readonly epoch: number;
  readonly productId: Id<'Product'>;
  readonly offerId: Id<'Offer'>;
  readonly creditedAt: Temporal.Instant;
}

/**
 * The seller review standings and their credits (`catalog.seller_review_standings`,
 * `catalog.seller_review_credits`; slice 4). Every method runs in the caller's unit through the
 * Market-scoped client. Lock order of a unit: the Offer row first, then the standing.
 */
export interface SellerReviewStandingRepository {
  /**
   * The seller's standing, created at version 1 when it has none (`ON CONFLICT DO NOTHING`), then
   * locked until the unit ends by raising its version by one (the guard requires exactly one per
   * UPDATE). Answers the locked standing at its new version.
   */
  lock(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    now: Temporal.Instant,
  ): Promise<SellerReviewStanding>;

  /**
   * Saves a changed standing locked by this unit: one UPDATE where the version is the loaded one,
   * raising it by one. Throws `StaleAggregateError` when no row matched.
   */
  save(market: MarketContext, standing: SellerReviewStanding): Promise<void>;

  /**
   * Credits a product once per epoch (`ON CONFLICT DO NOTHING`); true when a new credit was
   * written. The epoch must be the standing's current one (guard).
   */
  credit(market: MarketContext, credit: SellerReviewCredit): Promise<boolean>;

  /** The number of credits of the seller in an epoch (an index-only count on the key). */
  count(market: MarketContext, sellerId: Id<'Seller'>, epoch: number): Promise<number>;

  /** The standing and its current count, or null when the seller has none yet. No lock. */
  read(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<{ readonly state: SellerReviewStandingState; readonly count: number } | null>;
}

export const SELLER_REVIEW_STANDING_REPOSITORY = Symbol(
  'CATALOG_SELLER_REVIEW_STANDING_REPOSITORY',
);
