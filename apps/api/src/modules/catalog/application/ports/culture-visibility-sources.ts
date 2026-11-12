import type { CallContext, Id, Result } from '@mondapac/shared-kernel';

/** A source of the visibility rule could not answer: the caller answers "not visible" (fail closed). */
export interface CultureVisibilitySourceUnavailable {
  readonly code: 'culture-visibility.source-unavailable';
}

/** The most sellers one call of either source takes (the sellers and certification facades' cap). */
export const VISIBILITY_SOURCE_BATCH = 100;

/**
 * The cultures each seller is `approved` in (multi-culture package 3a; ADR-0047 decision 5), bound
 * to sellers' `approvedCulturesOfSellers`. At most {@link VISIBILITY_SOURCE_BATCH} sellers per call.
 * A refusal, a fault or an answer of the wrong shape is unavailable, never "no culture" read as an
 * answer.
 */
export interface SellerMemberCultures {
  approvedCultures(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<
    Result<
      ReadonlyMap<Id<'Seller'>, ReadonlySet<Id<'Culture'>>>,
      CultureVisibilitySourceUnavailable
    >
  >;
}

/**
 * The certification types each seller holds a valid certificate of now (ADR-0048 security review
 * M2), bound to certification's `sellerValidCertificateTypes`. At most
 * {@link VISIBILITY_SOURCE_BATCH} sellers per call; unavailable as above.
 */
export interface SellerCertificateTypes {
  validTypes(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<
    Result<ReadonlyMap<Id<'Seller'>, ReadonlySet<string>>, CultureVisibilitySourceUnavailable>
  >;
}

export const SELLER_MEMBER_CULTURES = Symbol('CATALOG_SELLER_MEMBER_CULTURES');
export const SELLER_CERTIFICATE_TYPES = Symbol('CATALOG_SELLER_CERTIFICATE_TYPES');
