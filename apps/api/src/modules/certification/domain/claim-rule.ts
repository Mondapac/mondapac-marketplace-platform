import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { ClaimBasisRequirement, ClaimDecision, ClaimQuery, ClaimReason } from './claim-types';
import { sellerCertificateValidAt } from './validity';
import type { SellerCertificationView, SellerZones } from './validity';

/** A published policy row that matches the query (a category id of a path, or the handling). */
export interface MatchedPolicyRow {
  readonly basis: ClaimBasisRequirement;
}

/** Everything the application layer loaded for one query (design 4.2 steps 1 to 3). */
export interface ClaimFacts {
  /** `null`: the type does not exist in the Market. */
  readonly type: {
    readonly publishedRevisionId: Id;
    readonly defaultBasis: 'SELLER_REQUIRED' | 'NOT_APPLICABLE';
  } | null;
  readonly policy: {
    readonly revisionId: Id;
    readonly matchedRows: readonly MatchedPolicyRow[];
  } | null;
  /** The non-terminal certificate of (seller, type), or `null`. */
  readonly sellerCertificate: SellerCertificationView | null;
  /** Non-provisional zones from `sellers.approvedSellerZones`; `null` when either is missing. */
  readonly sellerZones: SellerZones | null;
}

// Strictness: NOT_APPLICABLE > SELLER_REQUIRED > SELLER_OR_MANUFACTURER (design 4.2 step 3, M1).
const STRICTNESS: Readonly<Record<ClaimBasisRequirement, number>> = {
  NOT_APPLICABLE: 2,
  SELLER_REQUIRED: 1,
  SELLER_OR_MANUFACTURER: 0,
};

/** The strictest of all matching rows; the type's default only when none match. */
export function resolveRequirement(
  defaultBasis: ClaimBasisRequirement,
  matchedRows: readonly MatchedPolicyRow[],
): ClaimBasisRequirement {
  let result: ClaimBasisRequirement | null = null;
  for (const row of matchedRows) {
    // An unknown basis (not in the closed list) is read as the strictest: fail closed.
    const basis: ClaimBasisRequirement = Object.hasOwn(STRICTNESS, row.basis)
      ? row.basis
      : 'NOT_APPLICABLE';
    if (result === null || STRICTNESS[basis] > STRICTNESS[result]) result = basis;
  }
  return result ?? (Object.hasOwn(STRICTNESS, defaultBasis) ? defaultBasis : 'NOT_APPLICABLE');
}

function deny(
  query: ClaimQuery,
  reason: ClaimReason,
  at: Temporal.Instant,
  policyRevisionId: Id | null = null,
): ClaimDecision {
  return {
    allowed: false,
    basis: null,
    reason,
    certificate: null,
    policyRevisionId,
    badge: null,
    inputs: query,
    evaluatedAt: at,
  };
}

/**
 * `ClaimRule.decide` (certification design 4.2, steps 3 to 7), pure. Slice 1 holds the seller
 * basis, the type default and `NOT_APPLICABLE`. The manufacturer basis arrives with slice 13;
 * until then a `SELLER_OR_MANUFACTURER` requirement that the seller basis does not satisfy ends
 * in `no-valid-seller-certificate` (fail closed). Callers handle input validation (step 0) and
 * turn any exception into `unavailable` (rule 1).
 */
export function decide(query: ClaimQuery, facts: ClaimFacts, at: Temporal.Instant): ClaimDecision {
  if (facts.type === null) return deny(query, 'type-unknown', at);

  const requirement = resolveRequirement(facts.type.defaultBasis, facts.policy?.matchedRows ?? []);
  const policyRevisionId =
    facts.policy !== null && facts.policy.matchedRows.length > 0 ? facts.policy.revisionId : null;

  if (requirement === 'NOT_APPLICABLE') {
    return deny(query, 'policy-not-applicable', at, policyRevisionId);
  }

  const cert = facts.sellerCertificate;
  if (cert === null) return deny(query, 'no-valid-seller-certificate', at, policyRevisionId);

  const validity = sellerCertificateValidAt(cert, facts.sellerZones, at);
  if (!validity.valid) {
    const reason: ClaimReason =
      validity.reason === 'seller-zone-missing'
        ? 'seller-zone-missing'
        : 'no-valid-seller-certificate';
    return deny(query, reason, at, policyRevisionId);
  }
  // `approved` is non-null when the validity is true.
  const sub = cert.approved as NonNullable<SellerCertificationView['approved']>;
  return {
    allowed: true,
    basis: 'SELLER',
    reason: 'allowed',
    certificate: {
      kind: 'seller',
      certificateId: cert.certificateId,
      versionId: validity.submissionId,
      issuerId: sub.issuerId,
      typeRevisionId: sub.typeRevisionId,
      validUntil: validity.expiresAt,
    },
    policyRevisionId,
    badge: null,
    inputs: query,
    evaluatedAt: at,
  };
}
