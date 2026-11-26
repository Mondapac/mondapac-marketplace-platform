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
  /**
   * The percent of Offers published at once that are sampled for post-publication review
   * (`offer-review-sampling`, slice 6): 0 to 100; absent, out of bounds or unreadable reads as the
   * safe 100.
   */
  readonly samplingPercent?: number;
  /**
   * True only on the safe answer given because the settings could not be read (slice 7b: the
   * preview then says "could not check" instead of a guess). Absent is false.
   */
  readonly degraded?: boolean;
}

/** The safe answer when the settings cannot be read: review everything (fail closed). */
export const SAFE_OFFER_REVIEW_SETTINGS: OfferReviewSettings = Object.freeze({
  mode: 'all',
  certificateBadges: 'review',
  // Mode `all` already sends every Offer to an admin; no stop banner reason is invented.
  emergencyStop: false,
  // Every Offer that is published at once anyway is checked after publication.
  samplingPercent: 100,
  degraded: true,
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
  /**
   * When the seller became Trusted (slice 6: the start of 30 days of double sampling); null in
   * probation, when Trusted by a count not stamped yet, or when a read failed. Absent is null.
   */
  readonly trustedSince?: Temporal.Instant | null;
}

/**
 * What the Offer review policy reads that is not on the Offer: the Market's settings and the facts
 * about the seller and the product. Both are read outside any unit. Neither throws: a failure is
 * the safe answer (review), never "publish".
 */
export interface OfferReviewInputs {
  settings(context: CallContext): Promise<OfferReviewSettings>;
  /**
   * With `offerId` (a first publication, slice 6), an Offer that was ever taken down after
   * publication is judged with R6 (`fullReview`) on; a failed read of that is R6 on and degraded.
   */
  facts(
    context: CallContext,
    subject: {
      readonly sellerId: Id<'Seller'>;
      readonly productId: Id<'Product'>;
      readonly offerId?: Id<'Offer'>;
    },
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

/** The latest first-publication decision of the policy about one Offer (slice 5). */
export interface FirstPublicationDecision {
  /** The Offer's version after the submit the decision is about. */
  readonly offerVersion: number;
  readonly reasons: readonly OfferReviewReason[];
}

/**
 * What the review queue reads about Offers waiting for their first publication (slice 5): the
 * reasons of each Offer's latest `first-publication` referral (the queue's reason chips and the
 * bulk approval's allow-list) and the certification type codes of its open tags (the bulk
 * approval's "one certificate type" check). Runs in the caller's unit, by Market.
 */
export interface OfferReviewQueueFacts {
  /**
   * The latest `first-publication` referral of each Offer (highest Offer version): its reasons and
   * the Offer version it decided (a bulk approval accepts the reasons only for the version it
   * approves, Hassan L2). An Offer with no such referral is left out of the map.
   */
  firstPublicationReasons(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<string, FirstPublicationDecision>>;

  /**
   * The Offers of the Market waiting for their first publication whose latest `first-publication`
   * referral carries any of `reasons` (the queue's `reasons` filter). The latest referral decides,
   * so a reason of an earlier submit never matches. The pending rows are a work list: the read
   * walks their referrals, never the Market's whole history.
   */
  pendingFirstPublicationsWithReasons(
    market: MarketContext,
    reasons: readonly OfferReviewReason[],
  ): Promise<readonly Id<'Offer'>[]>;

  /** The distinct type codes of each Offer's open (not removed) tags, sorted; an Offer with none is left out. */
  openTagTypes(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<string, readonly string[]>>;
}
export const OFFER_REVIEW_QUEUE_FACTS = Symbol('CATALOG_OFFER_REVIEW_QUEUE_FACTS');
