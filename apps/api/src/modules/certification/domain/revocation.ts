import { reasonFor, type ReviewPolicy, type ReviewReasonSpec } from './review';
import type { SellerCertificationStatus } from './validity';

// The pure rules of revoking a seller certificate (certification design 3.1 last row, 7.3; brief
// CERT-16, AC 16). `revoked` is terminal: nothing moves a record out of it (design 3.1 "Forbidden"),
// and validity (2.4 rule 1) grants only `approved`, so the claim is "no" from the instant the revoke
// commits, without waiting for any job or event consumer.

/** The record statuses a revoke can start from (design 3.1: `approved` or `expired` → `revoked`). */
export const REVOCABLE_STATUSES = [
  'approved',
  'expired',
] as const satisfies readonly SellerCertificationStatus[];

export type RevocationRefusal =
  { readonly code: 'certificate.revoked' } | { readonly code: 'certificate.not-revocable' };

/**
 * Null when the record may be revoked: it is `approved` or `expired` and holds an approved
 * submission. A record already `revoked` names that (a second revoke is never a new transition);
 * anything else (never approved, declined) is `certificate.not-revocable`.
 */
export function revocationRefusal(record: {
  readonly status: SellerCertificationStatus;
  readonly hasApproval: boolean;
}): RevocationRefusal | null {
  if (record.status === 'revoked') return { code: 'certificate.revoked' };
  if (!(REVOCABLE_STATUSES as readonly string[]).includes(record.status) || !record.hasApproval) {
    return { code: 'certificate.not-revocable' };
  }
  return null;
}

/**
 * The reason of a revoke, a value object (AC 16, design 7.3 "revoke needs a reason"): a code of the
 * Market's list that is listed for `revoked`. Missing is `required`; a code of another outcome or of
 * no list is `unknown`. The optional free text is the use case's (sealed under the seller's key).
 */
export function revocationReason(
  policy: ReviewPolicy,
  raw: unknown,
):
  | { readonly ok: true; readonly value: ReviewReasonSpec }
  | { readonly ok: false; readonly code: 'required' | 'unknown' } {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, code: 'required' };
  const reason = reasonFor(policy, raw, 'revoked');
  return reason === null ? { ok: false, code: 'unknown' } : { ok: true, value: reason };
}
