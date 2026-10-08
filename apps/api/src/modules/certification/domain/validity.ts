import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import type { TimeZoneId } from './claim-types';

export type IssuerState = 'proposed' | 'active' | 'closed-to-new' | 'derecognised';

export type SellerCertificationStatus =
  'draft' | 'in-review' | 'approved' | 'changes-needed' | 'declined' | 'expired' | 'revoked';

/** The approved submission as the validity measure needs it (design 2.4). */
export interface ApprovedSubmissionView {
  readonly submissionId: Id;
  readonly typeRevisionId: Id;
  /** The type revision the submission was made under decides this (rule 5). */
  readonly requiresExpiry: boolean;
  /** The expiry date as written, a local date. */
  readonly expiryDate: Temporal.PlainDate | null;
  /** The seller's zone when the submission was approved. */
  readonly zoneAtApproval: TimeZoneId;
  readonly issuerId: Id | null;
  readonly issuerState: IssuerState | null;
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
  | { readonly valid: true; readonly submissionId: Id; readonly expiresAt: Temporal.Instant | null }
  | { readonly valid: false; readonly reason: InvalidReason };

/** 00:00 on the day after `expiryDate` in `zone`; DST-safe because it is a start of day. */
/** The pair `sellers.approvedSellerZones` answers: the chosen zone and the zone the address gives. */
export interface SellerZones {
  readonly zone: TimeZoneId;
  readonly addressZone: TimeZoneId;
}

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
  if (sellerZones === null) return { valid: false, reason: 'seller-zone-missing' };

  if (!sub.requiresExpiry) {
    return { valid: true, submissionId: sub.submissionId, expiresAt: null };
  }
  if (sub.expiryDate === null) return { valid: false, reason: 'expiry-missing' };

  // The earliest of three: the boundary stored at approval, the chosen zone's and the address
  // zone's, so a chosen zone can only bring the boundary forward (T2, amended 2026-10-08).
  let boundary: Temporal.Instant;
  try {
    boundary = [
      expiryBoundary(sub.expiryDate, sub.zoneAtApproval),
      expiryBoundary(sub.expiryDate, sellerZones.zone),
      expiryBoundary(sub.expiryDate, sellerZones.addressZone),
    ].reduce((a, b) => (Temporal.Instant.compare(a, b) <= 0 ? a : b));
  } catch (error) {
    // A zone Temporal cannot resolve is "no zone": not allowed (design 4.2 step 1).
    if (error instanceof RangeError) return { valid: false, reason: 'seller-zone-missing' };
    throw error;
  }
  if (Temporal.Instant.compare(at, boundary) >= 0) return { valid: false, reason: 'expired' };
  return { valid: true, submissionId: sub.submissionId, expiresAt: boundary };
}
