import type { Id } from '@mondapac/shared-kernel';
import type { OfferPendingChange } from '../domain/offer-pending-change';
import {
  offerEditReviewReasons,
  type OfferEditReviewInput,
  type OfferReviewReason,
} from '../domain/offer-review-policy';
import { issueReviewClearance, type ReviewClearance } from '../domain/review-clearance';

// The only place that issues a {@link ReviewClearance} (slice 2c bypass guard; Hassan S1 on
// PR #1350). An import allow-list contract test (catalog-review-clearance.contract.spec.ts) holds
// who may call what: `policyVerdict` only `offer-edit-review.ts`; the two clearance factories only
// the three seller edit use cases and the approval.

/**
 * The review policy's verdict on one watched edit of one Offer: opaque outside this file. Only
 * {@link policyVerdict} makes one, by running the policy itself, so a clearance can never be
 * built from a reason list someone typed.
 */
export interface ReviewPolicyVerdict {
  readonly offerId: Id<'Offer'>;
  /** Why the edit is held; empty means it applies at once. */
  readonly reasons: readonly OfferReviewReason[];
}

// The verdicts made here, and nothing else: membership is the brand.
const VERDICTS = new WeakSet<object>();

/** Runs the edit rules for one Offer and seals the answer. Only `OfferEditReview` calls it. */
export function policyVerdict(
  offerId: Id<'Offer'>,
  input: OfferEditReviewInput,
): ReviewPolicyVerdict {
  const verdict: ReviewPolicyVerdict = Object.freeze({
    offerId,
    reasons: Object.freeze([...offerEditReviewReasons(input)]),
  });
  VERDICTS.add(verdict);
  return verdict;
}

/**
 * The clearance of an edit the review policy let through: only for a verdict made by
 * {@link policyVerdict} that found no reason, and only for that verdict's Offer. Anything else
 * (no verdict, a held one, a look-alike object) is no clearance: the domain then refuses a
 * watched change of a live Offer.
 */
export function clearanceFromPolicy(
  verdict: ReviewPolicyVerdict | null,
): ReviewClearance | undefined {
  if (verdict === null || !VERDICTS.has(verdict)) return undefined;
  return verdict.reasons.length === 0 ? issueReviewClearance('policy', verdict.offerId) : undefined;
}

/**
 * The clearance of a held change an admin approved in this unit: only for an approved change,
 * and bound to that change's Offer.
 */
export function clearanceFromApproval(change: OfferPendingChange): ReviewClearance {
  if (change.state.status !== 'approved' || !change.decided) {
    throw new Error('clearanceFromApproval: the change was not approved in this unit');
  }
  return issueReviewClearance('approval', change.state.offerId);
}
