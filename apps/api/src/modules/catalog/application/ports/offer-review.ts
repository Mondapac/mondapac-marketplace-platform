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
  /** R0 for the whole Market (the settings switch); the category and seller stops are facts. */
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
 * The facts as read for one decision (slice 4): the policy's facts, and whether any of them was
 * answered fail-closed because a read failed.
 */
export interface OfferReviewFactsRead extends OfferReviewFacts {
  /**
   * True when a read failed and its fact is the safe answer: the sellers facade (probation and
   * full review on), the standing (probation on) or the categories (sensitive on). The stop is
   * never invented. An edit with degraded facts is judged in mode `all`.
   */
  readonly degraded: boolean;
  /**
   * The seller is Trusted by its count with N read now but `trusted_at` is not stamped yet (N was
   * lowered): the submit unit stamps it, so raising N later never demotes the seller.
   */
  readonly stampTrust: boolean;
  /** N as read (the safe 100 when it cannot be read). */
  readonly probationOffers: number;
}

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
  ): Promise<OfferReviewFactsRead>;
  /** N (`offer-review-probation-offers`): a whole number from 0 to 100, else the safe 100. */
  probationOffers(context: CallContext): Promise<number>;
}
export const OFFER_REVIEW_INPUTS = Symbol('CATALOG_OFFER_REVIEW_INPUTS');

/** One automatic decision of the policy, kept for the queue's reason chips and the seller. */
export interface OfferReviewReferral {
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  /** The Offer's version after the change the decision is about. */
  readonly offerVersion: number;
  /** A seller's submit, or an edit of a live Offer (slice 2c: R2, R3, R5 and mode `all`). */
  readonly trigger: 'first-publication' | 'edit';
  /** Empty means published at once. */
  readonly reasons: readonly OfferReviewReason[];
  readonly policyVersion: number;
  readonly decidedAt: Temporal.Instant;
  /** The held change an `edit` referral sent to the queue; absent when the edit applied at once. */
  readonly pendingChangeId?: Id<'OfferPendingChange'> | null;
}

/** The insert-only store of referrals (catalog.offer_review_referrals); written in the unit. */
export interface OfferReviewReferralStore {
  record(market: MarketContext, referral: OfferReviewReferral): Promise<void>;
}
export const OFFER_REVIEW_REFERRAL_STORE = Symbol('CATALOG_OFFER_REVIEW_REFERRAL_STORE');

/**
 * What the review queue reads about Offers waiting for their first publication (slice 5): the
 * reasons of each Offer's latest `first-publication` referral (the queue's reason chips and the
 * bulk approval's allow-list) and the certification type codes of its open tags (the bulk
 * approval's "one certificate type" check). Runs in the caller's unit, by Market.
 */
export interface OfferReviewQueueFacts {
  /**
   * The reasons of the latest `first-publication` referral of each Offer (highest Offer version);
   * an Offer with no such referral is left out of the map.
   */
  firstPublicationReasons(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<string, readonly OfferReviewReason[]>>;

  /** The distinct type codes of each Offer's open (not removed) tags, sorted; an Offer with none is left out. */
  openTagTypes(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<string, readonly string[]>>;
}
export const OFFER_REVIEW_QUEUE_FACTS = Symbol('CATALOG_OFFER_REVIEW_QUEUE_FACTS');
