import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import type {
  ClaimBasisRequirement,
  ClaimDecision,
  ClaimQuery,
  ClaimReason,
  TimeZoneId,
} from './claim-types';
import { manufacturerBadge, sellerBadge } from './badge';
import type { VerificationMode } from './type-revision';
import { covers, productCertificateValidAt, sellerCertificateValidAt } from './validity';
import type {
  ApprovedProductRevisionView,
  ProductCertificationView,
  ProductValidity,
  SellerCertificationView,
  SellerZones,
} from './validity';

/** A published policy row that matches the query (a category id of a path, or the handling). */
export interface MatchedPolicyRow {
  readonly basis: ClaimBasisRequirement;
}

/** Everything the application layer loaded for one query (design 4.2 steps 1 to 3 and 6). */
export interface ClaimFacts {
  /** `null`: the type does not exist in the Market. */
  readonly type: {
    readonly publishedRevisionId: Id;
    readonly defaultBasis: 'SELLER_REQUIRED' | 'NOT_APPLICABLE';
    /** Immutable per type code; a `SELF_DECLARATION` type has no manufacturer basis (CERT-40). */
    readonly verificationMode: VerificationMode;
  } | null;
  readonly policy: {
    readonly revisionId: Id;
    readonly matchedRows: readonly MatchedPolicyRow[];
  } | null;
  /** The non-terminal certificate of (seller, type), or `null`. */
  readonly sellerCertificate: SellerCertificationView | null;
  /** Non-provisional zones from `sellers.approvedSellerZones`; `null` when either is missing. */
  readonly sellerZones: SellerZones | null;
  /**
   * The approved manufacturer certificates of the type covering the query (step 6), or `null`
   * when they were not read: both mean no manufacturer basis (fail closed).
   */
  readonly productCertificates: readonly ProductCertificationView[] | null;
  /** The Market's configured zone, which measures manufacturer expiry (2.4 rule 3). */
  readonly marketZone: TimeZoneId | null;
}

// Strictness: NOT_APPLICABLE > SELLER_REQUIRED > SELLER_OR_MANUFACTURER (design 4.2 step 3, M1).
const STRICTNESS: Readonly<Record<ClaimBasisRequirement, number>> = {
  NOT_APPLICABLE: 2,
  SELLER_REQUIRED: 1,
  SELLER_OR_MANUFACTURER: 0,
};

/** The strictness of a basis; an unknown value is the strictest (fail closed). */
export function basisStrictness(basis: ClaimBasisRequirement): number {
  return Object.hasOwn(STRICTNESS, basis) ? STRICTNESS[basis] : STRICTNESS.NOT_APPLICABLE;
}

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

/** True when the manufacturer basis may be considered at all for this type and query. */
function manufacturerBasisOpen(mode: VerificationMode): boolean {
  // Allow-list: only a third-party document type (CERT-40); an unknown mode never opens it.
  return mode === 'THIRD_PARTY_DOCUMENT';
}

type Covering = {
  readonly cert: ProductCertificationView;
  readonly revision: ApprovedProductRevisionView;
  readonly validity: Extract<ProductValidity, { valid: true }>;
};

/** The covering, valid certificate with the latest boundary (no expiry is the latest). */
function bestCovering(
  query: ClaimQuery,
  certificates: readonly ProductCertificationView[],
  marketZone: TimeZoneId | null,
  at: Temporal.Instant,
): Covering | null {
  let best: Covering | null = null;
  for (const cert of certificates) {
    const revision = cert.approved;
    if (revision === null || !covers(revision, query)) continue;
    const validity = productCertificateValidAt(cert, marketZone, at);
    if (!validity.valid) continue;
    if (best === null) {
      best = { cert, revision, validity };
      continue;
    }
    const mine = validity.expiresAt;
    const theirs = best.validity.expiresAt;
    if (theirs !== null && (mine === null || Temporal.Instant.compare(mine, theirs) > 0)) {
      best = { cert, revision, validity };
    }
  }
  return best;
}

/**
 * `ClaimRule.decide` (certification design 4.2, steps 3 to 7), pure. The requirement is the
 * strictest of all matching rows, the type's default when none match (M1). `NOT_APPLICABLE`
 * denies both bases. A valid seller certificate allows on the seller basis, also when the
 * manufacturer basis would hold (ADR-0012 d7). Only under `SELLER_OR_MANUFACTURER`, for a
 * third-party-document type, the manufacturer basis needs, in this order: handling
 * `SEALED_ORIGINAL` (else `handling-requires-seller`), the per-Offer attestation (else
 * `attestation-missing`) and an approved, valid manufacturer certificate covering the product
 * revision and variant (else `not-covered`). No manufacturer certificate, or none read, is
 * `not-covered`: the basis never opens without one (fail closed). Callers handle input
 * validation (step 0) and turn any exception into `unavailable` (rule 1).
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
  let sellerReason: ClaimReason = 'no-valid-seller-certificate';
  if (cert !== null) {
    const validity = sellerCertificateValidAt(cert, facts.sellerZones, at);
    if (validity.valid) {
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
        // Built here, from the decision just made, and only when allowed (design 4.5).
        badge: sellerBadge(query.typeCode, sub, validity),
        inputs: query,
        evaluatedAt: at,
      };
    }
    if (validity.reason === 'seller-zone-missing') sellerReason = 'seller-zone-missing';
  }

  if (
    requirement !== 'SELLER_OR_MANUFACTURER' ||
    !manufacturerBasisOpen(facts.type.verificationMode)
  ) {
    return deny(query, sellerReason, at, policyRevisionId);
  }
  if (query.handling !== 'SEALED_ORIGINAL') {
    return deny(query, 'handling-requires-seller', at, policyRevisionId);
  }
  if (query.attestationRecorded !== true) {
    return deny(query, 'attestation-missing', at, policyRevisionId);
  }
  const covering = bestCovering(query, facts.productCertificates ?? [], facts.marketZone, at);
  if (covering === null) return deny(query, 'not-covered', at, policyRevisionId);
  const { cert: product, revision, validity } = covering;
  return {
    allowed: true,
    basis: 'MANUFACTURER',
    reason: 'allowed',
    certificate: {
      kind: 'manufacturer',
      certificateId: product.certificateId,
      versionId: validity.revisionId,
      issuerId: revision.issuerId,
      typeRevisionId: facts.type.publishedRevisionId,
      validUntil: validity.expiresAt,
    },
    policyRevisionId,
    badge: manufacturerBadge(query.typeCode, facts.type.publishedRevisionId, revision, validity),
    inputs: query,
    evaluatedAt: at,
  };
}
