import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { OfferHandling } from '../domain/offer-handling';
import { offerReviewReasons, type OfferReviewReason } from '../domain/offer-review-policy';
import {
  SAFE_OFFER_REVIEW_SETTINGS,
  type OfferReviewFactsRead,
  type OfferReviewInputs,
  type OfferReviewSettings,
} from './ports/offer-review';

/** What the first-publication rules judge about one Offer (the facts are read here). */
export interface FirstPublicationSubject {
  readonly sellerId: Id<'Seller'>;
  readonly productId: Id<'Product'>;
  readonly offerId: Id<'Offer'>;
  readonly handling: OfferHandling;
  /** The badge types the Offer will carry after the submit (kept and requested). */
  readonly badgeTypes: readonly string[];
  /** Locale to text. */
  readonly description: Readonly<Record<string, string>>;
}

/** The decision of the first-publication rules and what it was made from. */
export interface FirstPublicationJudgement {
  /** Empty means published at once. */
  readonly reasons: readonly OfferReviewReason[];
  readonly settings: OfferReviewSettings;
  readonly facts: OfferReviewFactsRead;
  /** A fact could not be read (degraded): judged in the safe settings. */
  readonly safe: boolean;
  /**
   * A fact or the settings could not be read, so the answer is the fail-closed one and not the
   * Market's real rules. The submit queues the Offer anyway; the preview answers "could not check".
   */
  readonly unreadable: boolean;
}

/**
 * The Offer review policy at first publication (ADR-0051): the Market's settings and the facts
 * about the seller and the product, read outside any unit, then {@link offerReviewReasons}. The one
 * place both the submit and its preview (slice 7b) judge an Offer, so the preview can never drift
 * from the real rules. Facts read with a failure (degraded) are judged in the safe settings: mode
 * `all` and badges reviewed, so a stop that could not be read never lets an Offer go live in mode
 * `off` (Hassan M1 on PR #1358). No stop is invented. Never throws: each read answers "review" on a
 * failure.
 */
export async function judgeFirstPublication(
  inputs: OfferReviewInputs,
  context: CallContext,
  subject: FirstPublicationSubject,
): Promise<FirstPublicationJudgement> {
  const { sellerId, productId, offerId } = subject;
  const [settings, facts] = await Promise.all([
    inputs.settings(context),
    inputs.facts(context, { sellerId, productId, offerId }),
  ]);
  const safe = facts.degraded === true;
  const reasons = offerReviewReasons({
    mode: safe ? SAFE_OFFER_REVIEW_SETTINGS.mode : settings.mode,
    certificateBadges: safe
      ? SAFE_OFFER_REVIEW_SETTINGS.certificateBadges
      : settings.certificateBadges,
    facts: { ...facts, emergencyStop: facts.emergencyStop || settings.emergencyStop },
    handling: subject.handling,
    badgeTypes: subject.badgeTypes,
    description: subject.description,
  });
  return { reasons, settings, facts, safe, unreadable: safe || settings.degraded === true };
}
