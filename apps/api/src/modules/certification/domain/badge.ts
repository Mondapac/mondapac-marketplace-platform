import type { BadgeData, CertificationTypeCode } from './claim-types';
import type {
  ApprovedProductRevisionView,
  ApprovedSubmissionView,
  ProductValidity,
  Validity,
} from './validity';

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
 * - "verified with issuer" also needs the issuer to be shown;
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
    // Only with a shown issuer: "verified with issuer" never stands without the issuer named.
    verifiedWithIssuer: !sellerClaim && issuer !== null && submission.verifiedWithIssuer === true,
    reviewedByPlatform: true,
  };
}

/**
 * Badge data of an allowed manufacturer-basis decision (design 4.5; ADR-0012 d4), pure and called
 * only by `ClaimRule.decide`. A manufacturer certificate is always a third-party document, so it
 * is never a seller claim; the issuer and "verified with issuer" follow the same rules as the
 * seller badge; the validity date and zone are those of the boundary the decision used (2.4 rule
 * 3, the Market zone). `typeRevisionId` is the revision's own approved type revision (I1).
 */
export function manufacturerBadge(
  typeCode: CertificationTypeCode,
  typeRevisionId: BadgeData['typeRevisionId'],
  revision: ApprovedProductRevisionView,
  validity: Extract<ProductValidity, { valid: true }>,
): BadgeData {
  const issuer =
    typeof revision.issuerDisplayName === 'string' && revision.issuerDisplayName.length > 0
      ? { id: revision.issuerId, displayName: revision.issuerDisplayName }
      : null;
  const dated = validity.expiresAt !== null;
  return {
    typeCode,
    typeRevisionId,
    basis: 'MANUFACTURER',
    sellerClaim: false,
    issuer,
    validUntilLocalDate: dated ? validity.expiryDate : null,
    validUntilZone: dated ? validity.expiryZone : null,
    verifiedWithIssuer: issuer !== null && revision.verifiedWithIssuer === true,
    reviewedByPlatform: true,
  };
}
