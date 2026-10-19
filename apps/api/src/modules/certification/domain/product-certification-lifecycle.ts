import { Temporal } from '@mondapac/shared-kernel';
import type { TimeZoneId } from './claim-types';
import { actionForBoundary, type ExpiryAction, type JobBoundary } from './expiry';
import { reasonFor, type ReviewPolicy, type ReviewReasonSpec } from './review';
import {
  expiryBoundary,
  isUsableZone,
  type IssuerState,
  type ProductCertificationStatus,
} from './validity';

// The pure rules of a manufacturer certificate after its approval (certification design 3.4 rows
// 6 to 9, 8.6, 11; ADR-0012 d3; slice 15): an admin suspends it or revokes it with a reason,
// another person reinstates a suspended one, and the expiry job moves an approved one to
// `expired` at its boundary. `evaluateClaims` grants only an `approved` record (2.4 rule 1), so a
// suspension or a revocation is "no" from its commit, without waiting for any job or consumer.

interface RecordState {
  readonly status: ProductCertificationStatus;
  /** The record holds an approved revision (the approved pointer is set). */
  readonly hasApproval: boolean;
}

export type ProductSuspensionRefusal =
  | { readonly code: 'certificate.suspended' }
  | { readonly code: 'certificate.closed' }
  | { readonly code: 'certificate.not-suspendable' };

/**
 * Null when the record may be suspended (design 3.4 row 6: `approved` → `suspended`). A record
 * already suspended names that; a revoked or rejected one is closed; any other (never approved,
 * expired) is not suspendable.
 */
export function productSuspensionRefusal(record: RecordState): ProductSuspensionRefusal | null {
  if (record.status === 'suspended') return { code: 'certificate.suspended' };
  if (record.status === 'revoked' || record.status === 'rejected') {
    return { code: 'certificate.closed' };
  }
  if (record.status !== 'approved' || !record.hasApproval) {
    return { code: 'certificate.not-suspendable' };
  }
  return null;
}

export type ProductRevocationRefusal =
  { readonly code: 'certificate.revoked' } | { readonly code: 'certificate.not-revocable' };

/**
 * Null when the record may be revoked (design 3.4 row 8: `approved` or `suspended` → `revoked`,
 * terminal). A record already revoked names that; anything else is not revocable.
 */
export function productRevocationRefusal(record: RecordState): ProductRevocationRefusal | null {
  if (record.status === 'revoked') return { code: 'certificate.revoked' };
  if ((record.status !== 'approved' && record.status !== 'suspended') || !record.hasApproval) {
    return { code: 'certificate.not-revocable' };
  }
  return null;
}

/**
 * The reason of a suspension, a value object (design 3.4 row 6 "reason"): a code of the Market's
 * list that is listed for `suspended`. Missing is `required`; a code of another outcome or of no
 * list is `unknown`. A revocation uses the seller path's `revocationReason` (outcome `revoked`).
 */
export function suspensionReason(
  policy: ReviewPolicy,
  raw: unknown,
):
  | { readonly ok: true; readonly value: ReviewReasonSpec }
  | { readonly ok: false; readonly code: 'required' | 'unknown' } {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, code: 'required' };
  const reason = reasonFor(policy, raw, 'suspended');
  return reason === null ? { ok: false, code: 'unknown' } : { ok: true, value: reason };
}

export interface ProductReinstateInput extends RecordState {
  readonly actorAccountId: string;
  /** The record's creator. */
  readonly authorAccountId: string;
  /** Every admin who edited the draft of the approved revision, and its submitter. */
  readonly editorAccountIds: readonly string[];
  /** The approved revision's issuer, share-locked in the unit. */
  readonly issuer: { readonly state: IssuerState; readonly typeMatches: boolean } | null;
  /** From the approved revision's own type revision (I1). */
  readonly requiresExpiry: boolean;
  readonly expiryDate: Temporal.PlainDate | null;
  /** The boundary stored at approval. */
  readonly storedBoundary: Temporal.Instant | null;
  /** The Market's current zone; null when it is not usable. */
  readonly marketZone: TimeZoneId | null;
  readonly now: Temporal.Instant;
}

export type ProductReinstateRefusal =
  | { readonly code: 'approval.same-admin' }
  | { readonly code: 'certificate.closed' }
  | { readonly code: 'certificate.not-suspended' }
  | { readonly code: 'issuer.not-active' }
  | { readonly code: 'certificate.expired' };

/**
 * The guards of a reinstatement (design 3.4 row 7: `suspended` → `approved`, a re-review of the
 * approved revision; 7.1 "approve, reject, reinstate, by another person"): the actor is not the
 * record's creator and not any admin who edited or submitted the approved revision; the record is
 * suspended with an approved revision; its issuer still counts (`active` or `closed-to-new`: an
 * approved certificate of a closed issuer stays valid to its boundary, a derecognised one never
 * counts); and, when the type revision requires an expiry, the boundary the claim would use (the
 * earlier of the stored one and the one in the Market's current zone) is after now. No usable
 * Market zone then is a refusal (fail closed). `null` allows it.
 */
export function productReinstateRefusal(
  input: ProductReinstateInput,
): ProductReinstateRefusal | null {
  if (
    input.actorAccountId === input.authorAccountId ||
    input.editorAccountIds.includes(input.actorAccountId)
  ) {
    return { code: 'approval.same-admin' };
  }
  if (input.status === 'revoked' || input.status === 'rejected') {
    return { code: 'certificate.closed' };
  }
  if (input.status !== 'suspended' || !input.hasApproval) {
    return { code: 'certificate.not-suspended' };
  }
  if (
    input.issuer === null ||
    !input.issuer.typeMatches ||
    (input.issuer.state !== 'active' && input.issuer.state !== 'closed-to-new')
  ) {
    return { code: 'issuer.not-active' };
  }
  if (input.requiresExpiry) {
    const boundary = claimBoundary(input.expiryDate, input.storedBoundary, null, input.marketZone);
    if (
      boundary === null ||
      input.marketZone === null ||
      Temporal.Instant.compare(input.now, boundary.at) >= 0
    ) {
      return { code: 'certificate.expired' };
    }
  }
  return null;
}

/** What the expiry job knows of an approved manufacturer certificate (its approved revision). */
export interface ProductExpiryFacts {
  readonly status: ProductCertificationStatus;
  /** From the approved revision's own type revision (I1; 2.4 rule 5). */
  readonly requiresExpiry: boolean;
  readonly expiryDate: Temporal.PlainDate | null;
  /** The boundary stored on the approval decision (Hassan L1: read as stored). */
  readonly storedBoundary: Temporal.Instant | null;
  /** The Market zone the stored boundary was measured in. */
  readonly boundaryZone: string | null;
  /** The thresholds already marked for the approved revision. */
  readonly warnedThresholds: readonly number[];
}

/**
 * The boundary `evaluateClaims` uses for a manufacturer certificate (validity.ts,
 * `productCertificateValidAt`): the earlier of the stored boundary and the boundary of the expiry
 * date in the Market's current zone (when usable), with the zone that gave it so a warning day is
 * counted in Market time. Null without a date or a stored boundary.
 */
function claimBoundary(
  expiryDate: Temporal.PlainDate | null,
  storedBoundary: Temporal.Instant | null,
  storedZone: string | null,
  marketZone: TimeZoneId | null,
): JobBoundary | null {
  if (expiryDate === null || storedBoundary === null) return null;
  let earliest: JobBoundary = {
    at: storedBoundary,
    zone: isUsableZone(storedZone) ? storedZone : null,
  };
  if (marketZone !== null && isUsableZone(marketZone)) {
    let current: Temporal.Instant | null = null;
    try {
      current = expiryBoundary(expiryDate, marketZone);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    // On a tie the current zone is named, as the claim does.
    if (current !== null && Temporal.Instant.compare(current, earliest.at) <= 0) {
      earliest = { at: current, zone: marketZone };
    }
  }
  return earliest;
}

/**
 * What the expiry job does with one manufacturer certificate at `at` (design 3.4 row 9, 8.6:
 * "Manufacturer certificates in the Market zone, same"): only an `approved` record whose type
 * revision requires an expiry moves. Its boundary is the claim's (the stored one, or the one in
 * the Market's current zone when that is earlier), so the status never lags the claim and never
 * runs ahead of it. Past it the record expires; before it the most urgent due threshold is warned
 * once, from 00:00 Market time of the day T days before the boundary's day.
 */
export function productExpiryActionAt(
  facts: ProductExpiryFacts,
  marketZone: TimeZoneId | null,
  thresholds: readonly number[],
  at: Temporal.Instant,
): ExpiryAction {
  if (facts.status !== 'approved' || !facts.requiresExpiry) return { kind: 'none' };
  const boundary = claimBoundary(
    facts.expiryDate,
    facts.storedBoundary,
    facts.boundaryZone,
    marketZone,
  );
  if (boundary === null) return { kind: 'none' };
  return actionForBoundary(boundary, thresholds, facts.warnedThresholds, at);
}
