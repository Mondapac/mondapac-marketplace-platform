import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { OfferReviewFlag, OfferReviewFlagsState } from '../../domain/offer-review-flags';

/** One row of the insert-only change log (`sellers.offer_review_flag_changes`). */
export interface OfferReviewFlagChangeEntry {
  readonly id: Id<'OfferReviewFlagChange'>;
  readonly sellerId: Id<'Seller'>;
  readonly flag: OfferReviewFlag;
  readonly previous: boolean;
  readonly next: boolean;
  /** Trimmed, 1 to 500 characters. Admin text: never logged. */
  readonly reason: string;
  readonly by: Id<'Account'>;
  readonly at: Temporal.Instant;
}

/**
 * The seller's Offer review flags on `sellers.seller_admin_settings` (SEL-25, slice 4) and their
 * change log. Every method runs inside the caller's unit and is scoped by the Market.
 */
export interface OfferReviewFlagsRepository {
  /** The three flags and the row's version; null when the seller has no row in the Market. */
  read(market: MarketContext, sellerId: Id<'Seller'>): Promise<OfferReviewFlagsState | null>;

  /**
   * Sets one flag with who and when, only while the row is at `expectedVersion`, and raises the
   * version by one. False when no row matched (another change won, or no row).
   */
  set(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: {
      readonly flag: OfferReviewFlag;
      readonly on: boolean;
      readonly by: Id<'Account'>;
      readonly at: Temporal.Instant;
      readonly expectedVersion: number;
    },
  ): Promise<boolean>;

  /** Appends one change to the insert-only log, in the unit of the change. */
  appendChange(market: MarketContext, entry: OfferReviewFlagChangeEntry): Promise<void>;
}

export const OFFER_REVIEW_FLAGS_REPOSITORY = Symbol('OFFER_REVIEW_FLAGS_REPOSITORY');
