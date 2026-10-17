import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { OfferHandling } from './offer-handling';

// Certification tags on Offers (catalog design 5; ADR-0028). `catalog` never computes CERT-21: it
// asks `certification.evaluateClaims` and applies the answer under the rules here. These are
// catalog's own mirror types of the facade's `ClaimQuery`, `ClaimDecision` and `BadgeData`, so
// the domain imports no other module; the infrastructure adapter copies field by field.

/** The tag statuses of design 5.3 (data design 3.15). */
export const OFFER_TAG_STATUSES = [
  'pending-publish',
  'active',
  'rechecking',
  'suspended',
  'removed',
] as const;
export type OfferTagStatus = (typeof OFFER_TAG_STATUSES)[number];

/** The entry paths of ADR-0028 d5 that a tag history row names (data design 3.16, closed list). */
export const TAG_ENTRY_PATHS = [
  'offer-create',
  'offer-edit',
  'handling-change',
  'attestation-change',
  'tag-add',
  'revision-submit',
  'revision-publish',
  'revision-revert',
  // The reviewer's approval of an Offer's first publication (catalog slice 11; Hassan M1 part 1).
  'offer-approve',
  'category-change',
  'match',
  'promotion',
  'offer-reactivated',
  'tax-category-override',
  'import-row',
  'certification-event',
  'reconciliation',
  'seller-remove',
  'seller-remove-suspended',
  'offer-delete',
  'product-withdrawn',
  'product-retired',
] as const;
export type TagEntryPath = (typeof TAG_ENTRY_PATHS)[number];

export const TAG_BASES = ['SELLER', 'MANUFACTURER'] as const;
export type TagBasis = (typeof TAG_BASES)[number];

/** A certification type code (certification design 2.1): `^[a-z][a-z0-9-]{1,31}$`. */
const TYPE_CODE = /^[a-z][a-z0-9-]{1,31}$/;

/** True when the value has the shape of a certification type code. */
export function isTagTypeCode(value: unknown): value is string {
  return typeof value === 'string' && TYPE_CODE.test(value);
}

/**
 * One question "may this Offer carry this type for this variant" (design 5.1). Built only by
 * {@link claimQueriesFor} from the state the use case will store, never from a request.
 */
export interface TagClaimQuery {
  readonly sellerId: Id<'Seller'>;
  readonly productId: Id<'Product'>;
  readonly productRevisionId: Id<'ProductRevision'>;
  readonly variantId: Id<'Variant'>;
  readonly typeCode: string;
  readonly handling: OfferHandling;
  readonly attestationRecorded: boolean;
  readonly platformCategoryPaths: readonly (readonly Id<'Category'>[])[];
}

/**
 * The display copy of certification's badge data (certification design 4.5). Written only from a
 * decision of the same request; it can only restrict (ADR-0028 d3) and never authorises anything.
 * The texts and icon are certification's, found by `typeRevisionId`; the store name is not here.
 */
export interface TagBadge {
  readonly typeCode: string;
  readonly typeRevisionId: Id;
  readonly basis: TagBasis;
  readonly sellerClaim: boolean;
  readonly issuer: { readonly id: Id; readonly displayName: string } | null;
  /** An ISO calendar date (`YYYY-MM-DD`) in `validUntilZone`, or null. */
  readonly validUntilLocalDate: string | null;
  readonly validUntilZone: string | null;
  readonly verifiedWithIssuer: boolean;
  readonly reviewedByPlatform: true;
}

/** One answer of `evaluateClaims`, as catalog reads it. */
export interface TagDecision {
  readonly allowed: boolean;
  readonly basis: TagBasis | null;
  /** The closed `ClaimReason` code (CUX 3.7); `unavailable` never activates anything. */
  readonly reason: string;
  readonly certificate: {
    readonly kind: 'seller' | 'manufacturer';
    readonly certificateId: Id;
    readonly versionId: Id;
    readonly issuerId: Id | null;
    readonly typeRevisionId: Id;
    readonly validUntil: Temporal.Instant | null;
  } | null;
  readonly policyRevisionId: Id | null;
  readonly badge: TagBadge | null;
  /** The query echoed; compared with the state being saved (ADR-0028 d2). */
  readonly inputs: TagClaimQuery | null;
  readonly evaluatedAt: Temporal.Instant;
}

/**
 * The claim inputs a product contributes (design 5.1): the revision named, its non-retired
 * variants and the live paths of its platform categories. Read by `ClaimQueryBuilder` in the same
 * request, never kept.
 */
export interface ClaimFacts {
  readonly productId: Id<'Product'>;
  readonly productRevisionId: Id<'ProductRevision'>;
  /** True when the revision is the product's published one (5.1a point 5). */
  readonly revisionPublished: boolean;
  readonly variantIds: readonly Id<'Variant'>[];
  readonly platformCategoryPaths: readonly (readonly Id<'Category'>[])[];
}

/** The certificate part of the claim copy (design 5.4; data design 3.15). */
export interface TagCopy {
  readonly basis: TagBasis;
  readonly certificateKind: 'seller' | 'manufacturer';
  readonly certificateId: Id;
  readonly certificateVersionId: Id;
  readonly issuerId: Id | null;
  readonly typeRevisionId: Id;
  /** Null means the type's default (no policy row matched). */
  readonly policyRevisionId: Id | null;
  readonly validUntil: Temporal.Instant | null;
}

/** Who made a tag change; the history row records it (data design 3.16). */
export interface TagActor {
  readonly kind: 'seller' | 'admin' | 'system';
  /** Null exactly for the system actor. */
  readonly accountId: Id<'Account'> | null;
}

/** One tag of an Offer with its claim copy (design 5.4; data design 3.15). */
export interface OfferTagState {
  readonly id: Id<'OfferTag'>;
  readonly typeCode: string;
  readonly status: OfferTagStatus;
  /** The copy of the last allowed decision; kept while suspended so events can select the tag. */
  readonly copy: TagCopy | null;
  /** Present exactly while `active` (data design CHECK `offer_tags_badge_data_check`). */
  readonly badge: TagBadge | null;
  readonly copyRevisionId: Id<'ProductRevision'> | null;
  readonly copyRevisionPublished: boolean;
  /** SHA-256 of the canonical inputs, hex; null only before any decision. */
  readonly inputsHash: string | null;
  readonly lastReasonCode: string | null;
  readonly lastChangeCause: TagEntryPath | null;
  readonly evaluatedAt: Temporal.Instant;
  readonly statusChangedAt: Temporal.Instant;
  /** 1 at insert, one more with every status change (names the history row of the status). */
  readonly changeSeq: number;
  readonly removedAt: Temporal.Instant | null;
  readonly removedByKind: 'seller' | 'system' | null;
  readonly removedByAccountId: Id<'Account'> | null;
  readonly createdAt: Temporal.Instant;
}

/** The history row a tag change leaves (data design 3.16): one per status or basis change. */
export interface OfferTagPendingHistory {
  readonly tagId: Id<'OfferTag'>;
  readonly typeCode: string;
  readonly fromStatus: OfferTagStatus | null;
  readonly toStatus: OfferTagStatus;
  readonly changeSeq: number;
  readonly copy: TagCopy | null;
  readonly copyRevisionId: Id<'ProductRevision'> | null;
  readonly reasonCode: string | null;
  readonly entryPath: TagEntryPath;
  readonly actor: TagActor;
  readonly occurredAt: Temporal.Instant;
}

/** The verdict on one tag from the decisions of all its variants (design 5.2). */
export type TagJudgement =
  | {
      readonly kind: 'allowed';
      readonly copy: TagCopy;
      readonly badge: TagBadge;
      readonly evaluatedAt: Temporal.Instant;
    }
  | {
      readonly kind: 'not-allowed';
      readonly reason: string;
      readonly evaluatedAt: Temporal.Instant;
    }
  | { readonly kind: 'unavailable' }
  /** A returned input differs from the state being saved: the use case asks again (5.2 point 3). */
  | { readonly kind: 'stale' };

/**
 * One query per variant of the facts for one type (design 5.1). `null` when the Offer has no
 * handling yet: a claim cannot be asked without it, so nothing is allowed. The seller and product
 * come from the stored Offer only.
 */
export function claimQueriesFor(
  offer: {
    readonly sellerId: Id<'Seller'>;
    readonly productId: Id<'Product'>;
    readonly handling: OfferHandling | null;
    readonly attestationRecordedAt: unknown;
  },
  facts: ClaimFacts,
  typeCode: string,
): readonly TagClaimQuery[] | null {
  if (offer.handling === null) return null;
  if (facts.productId !== offer.productId) {
    throw new Error('claimQueriesFor: the facts are of another product');
  }
  const handling = offer.handling;
  return facts.variantIds.map((variantId) => ({
    sellerId: offer.sellerId,
    productId: offer.productId,
    productRevisionId: facts.productRevisionId,
    variantId,
    typeCode,
    handling,
    attestationRecorded: offer.attestationRecordedAt !== null,
    platformCategoryPaths: facts.platformCategoryPaths,
  }));
}

/** Field-by-field equality of a returned input and the query rebuilt from the state saved. */
export function sameClaimQuery(a: TagClaimQuery, b: TagClaimQuery): boolean {
  if (
    a.sellerId !== b.sellerId ||
    a.productId !== b.productId ||
    a.productRevisionId !== b.productRevisionId ||
    a.variantId !== b.variantId ||
    a.typeCode !== b.typeCode ||
    a.handling !== b.handling ||
    a.attestationRecorded !== b.attestationRecorded ||
    a.platformCategoryPaths.length !== b.platformCategoryPaths.length
  ) {
    return false;
  }
  return a.platformCategoryPaths.every((path, i) => {
    const other = b.platformCategoryPaths[i]!;
    return path.length === other.length && path.every((id, j) => id === other[j]);
  });
}

/**
 * The canonical text of the inputs a tag is decided on (design 5.4: revision id, variant ids,
 * handling, attestation, category paths); its SHA-256 is the stored `inputs_hash`.
 */
export function canonicalClaimInputs(queries: readonly TagClaimQuery[]): string {
  const first = queries[0];
  if (first === undefined) throw new Error('canonicalClaimInputs: no query');
  return JSON.stringify([
    first.productRevisionId,
    queries.map((query) => query.variantId),
    first.handling,
    first.attestationRecorded,
    first.platformCategoryPaths,
  ]);
}

function sameInstant(a: Temporal.Instant | null, b: Temporal.Instant | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

/** Every variant's badge is the same badge (Hassan I2): one copy and one badge cover the tag. */
function sameBadge(a: TagBadge, b: TagBadge): boolean {
  return (
    a.typeCode === b.typeCode &&
    a.typeRevisionId === b.typeRevisionId &&
    a.basis === b.basis &&
    a.sellerClaim === b.sellerClaim &&
    (a.issuer === null || b.issuer === null
      ? a.issuer === b.issuer
      : a.issuer.id === b.issuer.id && a.issuer.displayName === b.issuer.displayName) &&
    a.validUntilLocalDate === b.validUntilLocalDate &&
    a.validUntilZone === b.validUntilZone &&
    a.verifiedWithIssuer === b.verifiedWithIssuer &&
    a.reviewedByPlatform === b.reviewedByPlatform
  );
}

/**
 * The key of a tag's claim copy (data design 3.15, 3.16): a change of it, like a change of status,
 * raises `change_seq` and writes a history row (Mojtaba F1, Hassan M4). The same columns as the
 * trigger `offer_tags_change_seq` compares.
 */
export function tagCopyKey(tag: OfferTagState): string {
  const copy = tag.copy;
  return JSON.stringify([
    copy?.basis ?? null,
    copy?.certificateKind ?? null,
    copy?.certificateId ?? null,
    copy?.certificateVersionId ?? null,
    copy?.issuerId ?? null,
    copy?.typeRevisionId ?? null,
    copy?.policyRevisionId ?? null,
    copy?.validUntil?.toString() ?? null,
    tag.copyRevisionId,
  ]);
}

/**
 * The verdict on one tag (design 5.2). Fail closed throughout:
 * - any `unavailable` answer (or a missing one) is `unavailable`, never an allowed tag (point 4);
 * - an answer whose echoed inputs differ from the state being saved is `stale` (point 2, AC 9);
 * - every variant must be allowed (point 5, AC 15): the first refused variant gives the reason;
 * - the allowed answers must agree on one basis and one certificate version, and carry a badge of
 *   that type and basis, or the tag is not allowed (`not-covered`): one copy covers all variants.
 */
export function judgeTag(
  expected: readonly TagClaimQuery[],
  decisions: readonly TagDecision[] | undefined,
): TagJudgement {
  if (decisions === undefined || decisions.length !== expected.length) return { kind: 'stale' };
  const at = decisions[0]?.evaluatedAt;
  if (at === undefined) {
    // A product has at least one sell unit (M-1); a query set of none allows nothing.
    return { kind: 'unavailable' };
  }
  if (decisions.some((decision) => decision.reason === 'unavailable')) {
    return { kind: 'unavailable' };
  }
  // The reason `allowed` exactly when allowed (Hassan I2); anything else is a malformed answer.
  if (decisions.some((decision) => decision.allowed !== (decision.reason === 'allowed'))) {
    return { kind: 'unavailable' };
  }
  for (let i = 0; i < decisions.length; i += 1) {
    const inputs = decisions[i]!.inputs;
    if (inputs === null) {
      // Only `input-invalid` echoes nothing; it is a refusal, never a pass.
      if (decisions[i]!.allowed) return { kind: 'unavailable' };
      continue;
    }
    if (!sameClaimQuery(inputs, expected[i]!)) return { kind: 'stale' };
  }
  const refused = decisions.find((decision) => !decision.allowed);
  if (refused !== undefined) {
    return { kind: 'not-allowed', reason: refused.reason, evaluatedAt: at };
  }
  const first = decisions[0]!;
  const certificate = first.certificate;
  const badge = first.badge;
  const typeCode = expected[0]!.typeCode;
  if (
    first.basis === null ||
    certificate === null ||
    badge === null ||
    badge.typeCode !== typeCode ||
    badge.basis !== first.basis ||
    badge.typeRevisionId !== certificate.typeRevisionId
  ) {
    return { kind: 'not-allowed', reason: 'not-covered', evaluatedAt: at };
  }
  const agrees = decisions.every(
    (decision) =>
      decision.basis === first.basis &&
      decision.policyRevisionId === first.policyRevisionId &&
      decision.certificate !== null &&
      decision.certificate.kind === certificate.kind &&
      decision.certificate.certificateId === certificate.certificateId &&
      decision.certificate.versionId === certificate.versionId &&
      decision.certificate.issuerId === certificate.issuerId &&
      decision.certificate.typeRevisionId === certificate.typeRevisionId &&
      sameInstant(decision.certificate.validUntil, certificate.validUntil) &&
      decision.badge !== null &&
      sameBadge(decision.badge, badge),
  );
  if (!agrees) return { kind: 'not-allowed', reason: 'not-covered', evaluatedAt: at };
  return {
    kind: 'allowed',
    copy: {
      basis: first.basis,
      certificateKind: certificate.kind,
      certificateId: certificate.certificateId,
      certificateVersionId: certificate.versionId,
      issuerId: certificate.issuerId,
      typeRevisionId: certificate.typeRevisionId,
      policyRevisionId: first.policyRevisionId,
      validUntil: certificate.validUntil,
    },
    badge,
    evaluatedAt: at,
  };
}
