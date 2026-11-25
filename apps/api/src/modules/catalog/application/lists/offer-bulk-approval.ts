import type { OfferReviewReason } from '../../domain/offer-review-policy';

/**
 * The review reasons a bulk approval may clear (Hadi's decision 3, slice 5): R1 `probation`, R6
 * `full-review`, and R2 `certificate-badge` when every R2 row of the batch is one seller's and asks
 * one certificate type. Anything else (R0 stop, R3 handling, R5 contact text, R7 sensitive
 * category, `review-all`) needs a person to open the row.
 */
export const BULK_APPROVABLE_REASONS: readonly OfferReviewReason[] = Object.freeze([
  'probation',
  'full-review',
  'certificate-badge',
]);

/** Why a row of a bulk approval was left for a person. */
export const BULK_OFFER_SKIP_REASONS = [
  /** A reason outside {@link BULK_APPROVABLE_REASONS}; `blockers` names them. */
  'review.bulk-not-allowed',
  /** R2 rows of more than one seller or certificate type, or one row asking several types. */
  'review.bulk-certificate-mixed',
  /** No first-publication decision of the policy is stored for the Offer: fail closed. */
  'review.reasons-unknown',
] as const;
export type BulkOfferSkipReason = (typeof BULK_OFFER_SKIP_REASONS)[number];

export interface BulkOfferFacts {
  readonly offerId: string;
  readonly sellerId: string;
  /** The reasons of the Offer's latest first-publication referral; null when there is none. */
  readonly reasons: readonly OfferReviewReason[] | null;
  /** The type codes of the Offer's open tags (the certificate types it asks). */
  readonly tagTypes: readonly string[];
}

export type BulkOfferVerdict =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: BulkOfferSkipReason;
      /** The reasons that stop the row (empty for `review.reasons-unknown`). */
      readonly blockers: readonly string[];
    };

/**
 * Pure: whether each Offer of a bulk approval may be approved in bulk (enforced on the server; the
 * panel's disabled button is a hint only). A row passes when every reason it carries is bulk-able;
 * the R2 rows of the batch then also pass only together: one seller, one certificate type each
 * and the same type for all. A row with no stored reasons fails closed.
 */
export function bulkOfferApprovalVerdicts(
  rows: readonly BulkOfferFacts[],
): ReadonlyMap<string, BulkOfferVerdict> {
  const verdicts = new Map<string, BulkOfferVerdict>();
  const certificateRows: BulkOfferFacts[] = [];
  for (const row of rows) {
    if (row.reasons === null || row.reasons.length === 0) {
      verdicts.set(row.offerId, { allowed: false, reason: 'review.reasons-unknown', blockers: [] });
      continue;
    }
    const blockers = row.reasons.filter((reason) => !BULK_APPROVABLE_REASONS.includes(reason));
    if (blockers.length > 0) {
      verdicts.set(row.offerId, { allowed: false, reason: 'review.bulk-not-allowed', blockers });
      continue;
    }
    if (row.reasons.includes('certificate-badge')) certificateRows.push(row);
    verdicts.set(row.offerId, { allowed: true });
  }
  if (certificateRows.length > 0) {
    const sellers = new Set(certificateRows.map((row) => row.sellerId));
    const types = new Set(certificateRows.flatMap((row) => row.tagTypes));
    const single = certificateRows.every((row) => row.tagTypes.length === 1);
    if (sellers.size !== 1 || types.size !== 1 || !single) {
      for (const row of certificateRows) {
        verdicts.set(row.offerId, {
          allowed: false,
          reason: 'review.bulk-certificate-mixed',
          blockers: ['certificate-badge'],
        });
      }
    }
  }
  return verdicts;
}
