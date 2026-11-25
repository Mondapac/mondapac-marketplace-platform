import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';

/** A seller's Offer review flags as catalog reads them (SEL-25, through the sellers facade). */
export interface SellerOfferReviewFlags {
  readonly trustedFromStart: { readonly on: boolean; readonly at: Temporal.Instant | null };
  readonly fullReview: { readonly on: boolean; readonly at: Temporal.Instant | null };
  readonly reviewStop: { readonly on: boolean; readonly at: Temporal.Instant | null };
}

/**
 * `sellers.offerReviewFlagsOf`, read at decision time outside any unit (no event; the pattern of
 * `aiAccessOf`). Null for a refusal, an unknown seller, an error or a throw: the caller fails
 * closed (probation, full review, degraded).
 */
export interface SellerOfferReviewFlagsReader {
  flagsOf(context: CallContext, sellerId: Id<'Seller'>): Promise<SellerOfferReviewFlags | null>;
}

export const SELLER_OFFER_REVIEW_FLAGS_READER = Symbol('CATALOG_SELLER_OFFER_REVIEW_FLAGS_READER');
