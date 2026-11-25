import type { Id } from '@mondapac/shared-kernel';

declare const REVIEW_CLEARANCE: unique symbol;

/**
 * The bypass guard of the edit rules (risk-based Offer approval, slice 2c): on an Offer read as
 * `published`, a watched change (a changed description, handling changed to anything but
 * `SEALED_ORIGINAL`, a new tag) applies only with a clearance issued for that Offer. `policy`
 * after the review policy found no reason, `approval` after an admin approved the held change.
 *
 * The brand is a run-time one (Hassan S1 on PR #1350): a clearance is an object this module
 * issued and remembers, so an object literal or a cast never passes {@link isIssuedClearance}.
 * Only `application/offer-review-clearance.ts` calls {@link issueReviewClearance}; an import
 * allow-list contract test (`catalog-review-clearance.contract.spec.ts`) holds that.
 */
export interface ReviewClearance {
  readonly [REVIEW_CLEARANCE]: true;
  readonly basis: 'policy' | 'approval';
  /** The Offer the clearance was issued for; any other Offer refuses it. */
  readonly offerId: Id<'Offer'>;
}

// The clearances issued here, and nothing else: membership is the brand.
const ISSUED = new WeakSet<object>();

/** Issues a clearance for one Offer. Called only by the application's clearance file. */
export function issueReviewClearance(
  basis: ReviewClearance['basis'],
  offerId: Id<'Offer'>,
): ReviewClearance {
  const clearance = Object.freeze({ basis, offerId }) as unknown as ReviewClearance;
  ISSUED.add(clearance);
  return clearance;
}

/**
 * True for a clearance this module issued for `offerId` (and of `basis`, when given). Anything
 * else (undefined, a look-alike object, one issued for another Offer) is false.
 */
export function isIssuedClearance(
  value: unknown,
  offerId: Id<'Offer'>,
  basis?: ReviewClearance['basis'],
): value is ReviewClearance {
  if (typeof value !== 'object' || value === null || !ISSUED.has(value)) return false;
  const clearance = value as ReviewClearance;
  if (clearance.offerId !== offerId) return false;
  return basis === undefined || clearance.basis === basis;
}
