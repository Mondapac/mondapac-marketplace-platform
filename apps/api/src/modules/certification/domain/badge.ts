import type { BadgeData, CertificationTypeCode } from './claim-types';
import type { ApprovedSubmissionView, Validity } from './validity';

/**
 * Every field of {@link BadgeData}, the allow-list of design 4.5 (brief s5: type, basis, issuer,
 * validity date, "seller claim", "verified with issuer"). The certificate number, the holder's
 * name, the document, the reviewer, the scope text and the seller are never in it; the store name
 * is joined by the storefront from `sellers`. A spec pins this list against the built object.
 */
export const BADGE_FIELDS = [
  'typeCode',
  'typeRevisionId',
  'basis',
  'sellerClaim',
  'issuer',
  'validUntilLocalDate',
  'validUntilZone',
  'verifiedWithIssuer',
  'reviewedByPlatform',
] as const satisfies readonly (keyof BadgeData)[];

/**
 * Badge data of an allowed seller-basis decision (design 4.5; AC 23), pure. Called only by
 * `ClaimRule.decide` with the submission and validity it just allowed on, so there is no way to
 * build badge data from a decision passed in. Each field comes from the submission the decision
 * names:
 * - `typeRevisionId` is the revision the submission was approved under (its texts), never the
 *   type's current one, so easing a type never upgrades an approved badge;
 * - `sellerClaim` is true unless the mode is exactly `THIRD_PARTY_DOCUMENT` (an unknown mode reads
 *   as the weaker badge), and a seller claim is never "verified with issuer";
 * - the issuer appears only when both its id and its public registry name are known;
 * - the validity date and zone are those of the boundary the decision used (design 2.4 rule 2).
 */
export function sellerBadge(
  typeCode: CertificationTypeCode,
  submission: ApprovedSubmissionView,
  validity: Extract<Validity, { valid: true }>,
): BadgeData {
  const sellerClaim = submission.verificationMode !== 'THIRD_PARTY_DOCUMENT';
  const issuer =
    submission.issuerId !== null &&
    typeof submission.issuerDisplayName === 'string' &&
    submission.issuerDisplayName.length > 0
      ? { id: submission.issuerId, displayName: submission.issuerDisplayName }
      : null;
  const dated = validity.expiresAt !== null;
  return {
    typeCode,
    typeRevisionId: submission.typeRevisionId,
    basis: 'SELLER',
    sellerClaim,
    issuer,
    validUntilLocalDate: dated ? validity.expiryDate : null,
    validUntilZone: dated ? validity.expiryZone : null,
    verifiedWithIssuer: !sellerClaim && submission.verifiedWithIssuer === true,
    reviewedByPlatform: true,
  };
}
