import type { CallContext } from '@mondapac/shared-kernel';

/**
 * The stops of Offer review that live outside catalog (slice 5, the admin stop banner): the
 * Market's emergency stop (settings) and how many sellers have their review stop on (sellers,
 * SEL-25). Each answer is null when the owning module refused the caller or failed; never throws.
 */
export interface OfferReviewStopsReader {
  /** True when the Market's emergency stop (R0) is on; null when it cannot be read. */
  marketStop(context: CallContext): Promise<boolean | null>;
  /** Sellers of the Market with their review stop on; null when refused or unreadable. */
  stoppedSellerCount(context: CallContext): Promise<number | null>;
}

export const OFFER_REVIEW_STOPS_READER = Symbol('CATALOG_OFFER_REVIEW_STOPS_READER');
