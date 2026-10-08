import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import type { ClaimFacts } from '../../domain/claim-rule';
import type { CertificationTypeCode, Handling } from '../../domain/claim-types';
import type { SellerCertificationView } from '../../domain/validity';

/** What the type-and-policy statement answers for one query (design 4.2 step 3). */
export interface TypeAndPolicy {
  /** The type this answer is for; the use case checks it against the request (no matching by position alone). */
  readonly typeCode: CertificationTypeCode;
  readonly type: ClaimFacts['type'];
  readonly policy: ClaimFacts['policy'];
}

export interface PolicyRequest {
  readonly typeCode: CertificationTypeCode;
  /** Every category id of every platform path of the query. */
  readonly categoryIds: readonly Id<'Category'>[];
  readonly handling: Handling;
}

/** One certificate answer, carrying the key it answers (design 4.2 rule 2; Hassan M2). */
export interface SellerCertificateAnswer {
  readonly sellerId: Id<'Seller'>;
  readonly typeCode: CertificationTypeCode;
  readonly certificate: SellerCertificationView | null;
}

export interface SellerCertificateRequest {
  readonly sellerId: Id<'Seller'>;
  readonly typeCode: CertificationTypeCode;
}

/**
 * The two read statements behind `evaluateClaims` (design 4.2 steps 2 and 3), each one statement
 * in one read-only unit, so each basis is decided from one snapshot (rule 2). Both answer an
 * array aligned with the request, one entry per request, each carrying its key; a wrong length or a
 * key that differs from the request at its position is a fault (the batch answers unavailable).
 * Order must not depend on the database: a contract test shuffles it. The
 * Market comes from the `MarketContext` only. A failure rejects.
 */
export interface ClaimFactsReader {
  /** The published type revision and the policy rows matching the categories or the handling. */
  typesAndPolicies(
    market: MarketContext,
    requests: readonly PolicyRequest[],
  ): Promise<readonly TypeAndPolicy[]>;
  /** Per (seller, type), the non-terminal certificate with its approved submission, or null. */
  sellerCertificates(
    market: MarketContext,
    requests: readonly SellerCertificateRequest[],
  ): Promise<readonly SellerCertificateAnswer[]>;
}

/** One entry per requested seller; a missing zone is `null`, never a default. */
export type SellerZoneAnswer = ReadonlyMap<
  Id<'Seller'>,
  { readonly zone: string | null; readonly addressZone: string | null }
>;

/**
 * The fixed zone read of `sellers` (`approvedSellerZones`, request S-1), behind a port so the
 * application layer does not import another module. The adapter calls the `sellers` facade with
 * the caller's context unchanged; the answer is the same for every caller. A refusal rejects.
 */
export interface SellerZonesSource {
  zonesOf(context: CallContext, sellerIds: readonly Id<'Seller'>[]): Promise<SellerZoneAnswer>;
}
