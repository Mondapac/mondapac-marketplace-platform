import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import type { CertificationTypeCode, ClaimQuery, TimeZoneId } from './claim-types';
import type { VerificationMode } from './type-revision';

export type IssuerState = 'proposed' | 'active' | 'closed-to-new' | 'derecognised';

export type SellerCertificationStatus =
  'draft' | 'in-review' | 'approved' | 'changes-needed' | 'declined' | 'expired' | 'revoked';

/** The approved submission as the validity measure needs it (design 2.4). */
export interface ApprovedSubmissionView {
  readonly submissionId: Id;
  readonly typeRevisionId: Id;
  /** The type's mode (immutable per type code, repeated by every revision; data design 3.1). */
  readonly verificationMode: VerificationMode;
  /** The type revision the submission was made under decides this (rule 5). */
  readonly requiresExpiry: boolean;
  /** The expiry date as written, a local date. */
  readonly expiryDate: Temporal.PlainDate | null;
  /** The seller's zone when the submission was approved. */
  readonly zoneAtApproval: TimeZoneId;
  readonly issuerId: Id | null;
  readonly issuerState: IssuerState | null;
  /** The issuer's public registry name (badge data, design 4.5); `null` when no issuer is named. */
  readonly issuerDisplayName: string | null;
  /** A reviewer recorded a full issuer confirmation for this submission (design 3.2 rule 7). */
  readonly verifiedWithIssuer: boolean;
}

export interface SellerCertificationView {
  readonly certificateId: Id;
  readonly status: SellerCertificationStatus;
  readonly approved: ApprovedSubmissionView | null;
}

export type InvalidReason =
  | 'not-approved'
  | 'no-approved-submission'
  | 'issuer-derecognised'
  | 'expiry-missing'
  | 'seller-zone-missing'
  | 'expired';

export type Validity =
  | {
      readonly valid: true;
      readonly submissionId: Id;
      /** The boundary; `null` when the submission's type revision requires no expiry. */
      readonly expiresAt: Temporal.Instant | null;
      /** The expiry date as written; set exactly when `expiresAt` is. */
      readonly expiryDate: Temporal.PlainDate | null;
      /** The zone that gave the boundary (ADR-0005); set exactly when `expiresAt` is. */
      readonly expiryZone: TimeZoneId | null;
    }
  | { readonly valid: false; readonly reason: InvalidReason };

/** The pair `sellers.approvedSellerZones` answers: the chosen zone and the zone the address gives. */
export interface SellerZones {
  readonly zone: TimeZoneId;
  readonly addressZone: TimeZoneId;
}

/**
 * True for a zone Temporal resolves that is an IANA id: a non-empty string, not a UTC offset
 * (ADR-0005 decision 1). Anything else is "no zone" (design 4.2 step 1), whether or not the
 * certificate has an expiry.
 */
export function isUsableZone(zone: unknown): zone is TimeZoneId {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return false;
  if (/^[+-]/u.test(zone)) return false;
  try {
    // Compare what Temporal resolved with the input: its parser also takes ISO date-times
    // and offsets and keeps only the zone part, which must not count as an IANA id.
    const resolved =
      Temporal.Instant.from('2026-01-01T00:00:00Z').toZonedDateTimeISO(zone).timeZoneId;
    return !/^[+-]/u.test(resolved) && resolved.toLowerCase() === zone.toLowerCase();
  } catch {
    return false;
  }
}

/** 00:00 on the day after `expiryDate` in `zone`; DST-safe because it is a start of day. */
export function expiryBoundary(expiryDate: Temporal.PlainDate, zone: TimeZoneId): Temporal.Instant {
  return expiryDate.add({ days: 1 }).toZonedDateTime(zone).toInstant();
}

/**
 * The one validity measure of a seller certificate (certification design 2.4). Pure: time and
 * the seller's current non-provisional zone come in as arguments. The stored status `expired`
 * is never decisive: past the boundary the answer is "no" whether or not the job ran (rule 4).
 * Anything unexpected is "not valid" (fail closed).
 */
export function sellerCertificateValidAt(
  cert: SellerCertificationView,
  sellerZones: SellerZones | null,
  at: Temporal.Instant,
): Validity {
  // Only `approved` can grant. A stored `expired` never grants and never decides a denial that the
  // boundary would not (rule 4): past the boundary the answer is "no" whether or not the job ran.
  if (cert.status !== 'approved') {
    return { valid: false, reason: 'not-approved' };
  }
  const sub = cert.approved;
  if (sub === null) return { valid: false, reason: 'no-approved-submission' };
  // Allow-list: anything but an active or closed-to-new issuer (or none) is not valid (Hassan L1).
  if (
    sub.issuerState !== null &&
    sub.issuerState !== 'active' &&
    sub.issuerState !== 'closed-to-new'
  ) {
    return { valid: false, reason: 'issuer-derecognised' };
  }
  if (
    sellerZones === null ||
    !isUsableZone(sellerZones.zone) ||
    !isUsableZone(sellerZones.addressZone)
  ) {
    return { valid: false, reason: 'seller-zone-missing' };
  }

  if (!sub.requiresExpiry) {
    return {
      valid: true,
      submissionId: sub.submissionId,
      expiresAt: null,
      expiryDate: null,
      expiryZone: null,
    };
  }
  if (sub.expiryDate === null) return { valid: false, reason: 'expiry-missing' };

  // The earliest of three: the boundary stored at approval, the chosen zone's and the address
  // zone's, so a chosen zone can only bring the boundary forward (T2, amended 2026-10-08). On a
  // tie the current zones are named before the stored one (chosen, address, at approval), so the
  // badge names the seller's zone of today when it gives the same instant.
  let boundary: Temporal.Instant | null = null;
  let boundaryZone: TimeZoneId | null = null;
  try {
    for (const zone of [sellerZones.zone, sellerZones.addressZone, sub.zoneAtApproval]) {
      const candidate = expiryBoundary(sub.expiryDate, zone);
      if (boundary === null || Temporal.Instant.compare(candidate, boundary) < 0) {
        boundary = candidate;
        boundaryZone = zone;
      }
    }
  } catch (error) {
    // A zone Temporal cannot resolve is "no zone": not allowed (design 4.2 step 1).
    if (error instanceof RangeError) return { valid: false, reason: 'seller-zone-missing' };
    throw error;
  }
  if (boundary === null || boundaryZone === null) {
    return { valid: false, reason: 'seller-zone-missing' };
  }
  if (Temporal.Instant.compare(at, boundary) >= 0) return { valid: false, reason: 'expired' };
  return {
    valid: true,
    submissionId: sub.submissionId,
    expiresAt: boundary,
    expiryDate: sub.expiryDate,
    expiryZone: boundaryZone,
  };
}

export type ProductCertificationStatus =
  'draft' | 'in-review' | 'approved' | 'rejected' | 'suspended' | 'revoked' | 'expired';

/**
 * One coverage entry of an approved manufacturer revision (design 2.1, 3.4; CERT-41): a product
 * at the product revision it was checked against (M3), for the whole product (`variantId` null)
 * or narrowed to one variant.
 */
export interface CoverageEntryView {
  readonly productId: Id<'Product'>;
  readonly productRevisionId: Id<'ProductRevision'>;
  readonly variantId: Id<'Variant'> | null;
}

/** The approved revision of a manufacturer certificate as the validity measure needs it. */
export interface ApprovedProductRevisionView {
  readonly revisionId: Id;
  /**
   * The type revision the revision was submitted and approved under (I1, slice 14): it decides
   * `requiresExpiry` and the badge texts, as the seller path's submission does, so easing a type
   * later never upgrades an approved manufacturer certificate.
   */
  readonly typeRevisionId: Id;
  /** Whether the certificate's type required an expiry when the revision was approved. */
  readonly requiresExpiry: boolean;
  /** The expiry date as written, a local date. */
  readonly expiryDate: Temporal.PlainDate | null;
  /** The boundary stored at approval, in the Market zone of that time (2.4 rule 3). */
  readonly boundaryAtApproval: Temporal.Instant | null;
  readonly issuerId: Id;
  readonly issuerState: IssuerState | null;
  /** The issuer's public registry name (badge data). */
  readonly issuerDisplayName: string | null;
  readonly verifiedWithIssuer: boolean;
  /** The coverage entries of the revision for the asked product (or all of them). */
  readonly coverage: readonly CoverageEntryView[];
}

/** A manufacturer certificate (`ProductCertification`, slice 14) as `evaluateClaims` reads it. */
export interface ProductCertificationView {
  readonly certificateId: Id;
  /**
   * The certificate's type code (Hassan L2, slice 14): a certificate of another type never covers
   * a query, whatever the reader returned.
   */
  readonly typeCode: CertificationTypeCode;
  readonly status: ProductCertificationStatus;
  readonly approved: ApprovedProductRevisionView | null;
}

export type ProductValidity =
  | {
      readonly valid: true;
      readonly revisionId: Id;
      readonly expiresAt: Temporal.Instant | null;
      readonly expiryDate: Temporal.PlainDate | null;
      readonly expiryZone: TimeZoneId | null;
    }
  | { readonly valid: false; readonly reason: InvalidReason | 'market-zone-missing' };

/**
 * True when one coverage entry of the revision covers the query (design 2.1; 4.2 step 6): the
 * same product at the same published product revision (M3), and either the whole product or the
 * query's own variant. An entry narrowed to a variant never matches a query without one (L1).
 */
export function covers(revision: ApprovedProductRevisionView, query: ClaimQuery): boolean {
  return revision.coverage.some(
    (entry) =>
      entry.productId === query.productId &&
      entry.productRevisionId === query.productRevisionId &&
      (entry.variantId === null ||
        (query.variantId !== null && entry.variantId === query.variantId)),
  );
}

/**
 * The validity measure of a manufacturer certificate (design 2.4 rules 1 and 3), pure: valid
 * only when `approved`, with an approved revision whose issuer is not derecognised and, when an
 * expiry is required, before the earlier of the boundary stored at approval and the boundary in
 * the Market's current zone. A missing boundary, date or zone is "not valid" (fail closed).
 */
export function productCertificateValidAt(
  cert: ProductCertificationView,
  marketZone: TimeZoneId | null,
  at: Temporal.Instant,
): ProductValidity {
  if (cert.status !== 'approved') return { valid: false, reason: 'not-approved' };
  const revision = cert.approved;
  if (revision === null) return { valid: false, reason: 'no-approved-submission' };
  if (revision.issuerState !== 'active' && revision.issuerState !== 'closed-to-new') {
    return { valid: false, reason: 'issuer-derecognised' };
  }
  if (!revision.requiresExpiry) {
    return {
      valid: true,
      revisionId: revision.revisionId,
      expiresAt: null,
      expiryDate: null,
      expiryZone: null,
    };
  }
  if (revision.expiryDate === null || revision.boundaryAtApproval === null) {
    return { valid: false, reason: 'expiry-missing' };
  }
  if (marketZone === null || !isUsableZone(marketZone)) {
    return { valid: false, reason: 'market-zone-missing' };
  }
  let current: Temporal.Instant;
  try {
    current = expiryBoundary(revision.expiryDate, marketZone);
  } catch (error) {
    if (error instanceof RangeError) return { valid: false, reason: 'market-zone-missing' };
    throw error;
  }
  const boundary =
    Temporal.Instant.compare(revision.boundaryAtApproval, current) < 0
      ? revision.boundaryAtApproval
      : current;
  if (Temporal.Instant.compare(at, boundary) >= 0) return { valid: false, reason: 'expired' };
  return {
    valid: true,
    revisionId: revision.revisionId,
    expiresAt: boundary,
    expiryDate: revision.expiryDate,
    expiryZone: marketZone,
  };
}
