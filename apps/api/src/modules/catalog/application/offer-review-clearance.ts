import type { ReviewClearance } from '../domain/offer';
import type { OfferPendingChange } from '../domain/offer-pending-change';
import type { OfferReviewReason } from '../domain/offer-review-policy';

// The only place that issues a {@link ReviewClearance} (slice 2c bypass guard). A test reads the
// sources and fails when another non-test file builds one.

/** The clearance of an edit the review policy let through: only when it found no reason. */
export function clearanceFromPolicy(reasons: readonly OfferReviewReason[]): ReviewClearance | null {
  return reasons.length === 0
    ? (Object.freeze({ basis: 'policy' }) as unknown as ReviewClearance)
    : null;
}

/** The clearance of a held change an admin approved in this unit: only for an approved change. */
export function clearanceFromApproval(change: OfferPendingChange): ReviewClearance {
  if (change.state.status !== 'approved' || !change.decided) {
    throw new Error('clearanceFromApproval: the change was not approved in this unit');
  }
  return Object.freeze({ basis: 'approval' }) as unknown as ReviewClearance;
}
