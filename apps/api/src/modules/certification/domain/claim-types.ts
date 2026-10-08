import type { Id, Temporal } from '@mondapac/shared-kernel';

/** `^[a-z][a-z0-9-]{1,31}$`, unique per Market (certification design 2.1). */
export type CertificationTypeCode = string & { readonly __brand: 'CertificationTypeCode' };

/** An IANA zone id (ADR-0005 decision 2). */
export type TimeZoneId = string & { readonly __brand: 'TimeZoneId' };

export const HANDLING_VALUES = ['SEALED_ORIGINAL', 'REPACKED', 'PREPARED', 'FRESH'] as const;
export type Handling = (typeof HANDLING_VALUES)[number];

/** What a type or a policy row requires of a claim (design 2.1). */
export type ClaimBasisRequirement = 'SELLER_REQUIRED' | 'SELLER_OR_MANUFACTURER' | 'NOT_APPLICABLE';

/**
 * Closed reason codes of a decision (design 4.2). The manufacturer reasons are listed so the
 * facade type does not change when slice 13 adds that basis.
 */
export type ClaimReason =
  | 'allowed'
  | 'input-invalid'
  | 'unavailable'
  | 'type-unknown'
  | 'policy-not-applicable'
  | 'seller-zone-missing'
  | 'handling-requires-seller'
  | 'attestation-missing'
  | 'not-covered'
  | 'no-valid-seller-certificate';

/** One question of `evaluateClaims` (design 4.1, ADR-0028 d1). */
export interface ClaimQuery {
  readonly sellerId: Id<'Seller'>;
  readonly productId: Id<'Product'>;
  readonly productRevisionId: Id<'ProductRevision'>;
  readonly variantId: Id<'Variant'> | null;
  readonly typeCode: CertificationTypeCode;
  readonly handling: Handling;
  readonly attestationRecorded: boolean;
  readonly platformCategoryPaths: readonly (readonly Id<'Category'>[])[];
}

/** Badge data (design 4.5). Built in slice 10; until then a decision carries `null`. */
export interface BadgeData {
  readonly typeCode: CertificationTypeCode;
  readonly typeRevisionId: Id;
  readonly basis: 'SELLER' | 'MANUFACTURER';
  readonly sellerClaim: boolean;
  readonly issuer: { readonly id: Id; readonly displayName: string } | null;
  readonly validUntilLocalDate: Temporal.PlainDate | null;
  readonly validUntilZone: TimeZoneId | null;
  readonly verifiedWithIssuer: boolean;
  readonly reviewedByPlatform: true;
}

export interface ClaimDecision {
  readonly allowed: boolean;
  readonly basis: 'SELLER' | 'MANUFACTURER' | null;
  readonly reason: ClaimReason;
  readonly certificate: {
    readonly kind: 'seller' | 'manufacturer';
    readonly certificateId: Id;
    readonly versionId: Id;
    readonly issuerId: Id | null;
    readonly typeRevisionId: Id;
    readonly validUntil: Temporal.Instant | null;
  } | null;
  readonly policyRevisionId: Id | null;
  readonly badge: BadgeData | null;
  readonly inputs: ClaimQuery;
  readonly evaluatedAt: Temporal.Instant;
}
