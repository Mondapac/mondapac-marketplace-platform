import type { CallContext, Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  OfferReviewFacts,
  OfferReviewMode,
  OfferReviewReason,
} from '../../domain/offer-review-policy';

/** The Market's Offer review settings the policy reads (ADR-0051). */
export interface OfferReviewSettings {
  readonly mode: OfferReviewMode;
  readonly certificateBadges: 'review' | 'automatic';
  /** R0 for the whole Market (the settings switch); category and seller stops come later. */
  readonly emergencyStop: boolean;
}

/** The safe answer when the settings cannot be read: review everything (fail closed). */
export const SAFE_OFFER_REVIEW_SETTINGS: OfferReviewSettings = Object.freeze({
  mode: 'all',
  certificateBadges: 'review',
  // Mode `all` already sends every Offer to an admin; no stop banner reason is invented.
  emergencyStop: false,
});

/**
 * What the Offer review policy reads that is not on the Offer: the Market's settings and the facts
 * about the seller and the product. Both are read outside any unit. Neither throws: a failure is
 * the safe answer (review), never "publish".
 */
export interface OfferReviewInputs {
  settings(context: CallContext): Promise<OfferReviewSettings>;
  facts(
    context: CallContext,
    subject: { readonly sellerId: Id<'Seller'>; readonly productId: Id<'Product'> },
  ): Promise<OfferReviewFacts>;
}
export const OFFER_REVIEW_INPUTS = Symbol('CATALOG_OFFER_REVIEW_INPUTS');

/** One automatic decision of the policy, kept for the queue's reason chips and the seller. */
export interface OfferReviewReferral {
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  /** The Offer's version after the change the decision is about. */
  readonly offerVersion: number;
  /** `first-publication` today; edits join with the edit rules (R2, R3, R5, R7). */
  readonly trigger: 'first-publication';
  /** Empty means published at once. */
  readonly reasons: readonly OfferReviewReason[];
  readonly policyVersion: number;
  readonly decidedAt: Temporal.Instant;
}

/** The insert-only store of referrals (catalog.offer_review_referrals); written in the unit. */
export interface OfferReviewReferralStore {
  record(market: MarketContext, referral: OfferReviewReferral): Promise<void>;
}
export const OFFER_REVIEW_REFERRAL_STORE = Symbol('CATALOG_OFFER_REVIEW_REFERRAL_STORE');
