import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

export const REVIEW_REASONS = ['NEW_SELLER', 'HIGH_DISCOUNT', 'POST_REVIEW'] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];
export type ReviewStatus = 'OPEN' | 'APPROVED' | 'REJECTED';

export interface ReviewEntry {
  readonly id: Id<'PromotionReview'>;
  readonly promotionId: Id<'Promotion'>;
  readonly sellerId: Id<'Seller'>;
  readonly reason: ReviewReason;
  readonly status: ReviewStatus;
  readonly openedAt: Temporal.Instant;
  readonly decidedAt: Temporal.Instant | null;
}

/** The admin review queue of seller promotions (`promotions.promotion_reviews`). */
export interface ReviewQueueRepository {
  /**
   * Opens an entry. A promotion has at most one open entry: when it already has one, that entry
   * takes the new reason and the new `openedAt` (the seller changed the promotion again, and the
   * admin must look at it as it is now); its id and seller stay.
   */
  open(market: MarketContext, entry: ReviewEntry): Promise<void>;
  find(market: MarketContext, id: Id<'PromotionReview'>): Promise<ReviewEntry | null>;
  /** Oldest first. */
  listOpen(market: MarketContext, limit: number): Promise<readonly ReviewEntry[]>;
  decide(
    market: MarketContext,
    id: Id<'PromotionReview'>,
    status: 'APPROVED' | 'REJECTED',
    at: Temporal.Instant,
    by: Id<'Account'>,
  ): Promise<void>;
}

export const REVIEW_QUEUE_REPOSITORY = Symbol('PROMOTIONS_REVIEW_QUEUE_REPOSITORY');
