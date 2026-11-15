import type { CallContext, Id, Result } from '@mondapac/shared-kernel';

/** The certificate state could not be read: no partial answer, and approval is refused. */
export interface SellerCertificateDirectoryUnavailable {
  readonly code: 'seller-certificate-directory.unavailable';
}

/**
 * The certification types a seller holds a valid certificate of (approved, not past its expiry,
 * issuer not derecognised), for the approval of a membership in a culture with a required type
 * (ADR-0047 decision 3). Bound to certification's `sellerCertificateOverview` by
 * `SellerStoreProfileModule` (certification imports sellers). The caller's context goes through
 * unchanged, so certification's own gate decides who may ask; a refusal is unavailable.
 */
export interface SellerCertificateDirectory {
  /** Which of `typeCodes` the seller holds a valid certificate of now (a subset of them). */
  validTypeCodes(
    context: CallContext,
    sellerId: Id<'Seller'>,
    typeCodes: readonly string[],
  ): Promise<Result<ReadonlySet<string>, SellerCertificateDirectoryUnavailable>>;

  /**
   * One page (at most 200) of the sellers holding an approved certificate that names the issuer,
   * in seller id order after `afterSellerId` (ADR-0048 security review M3: a derecognised issuer).
   */
  sellersOfIssuer(
    context: CallContext,
    issuerId: string,
    afterSellerId: Id<'Seller'> | null,
    limit: number,
  ): Promise<Result<readonly Id<'Seller'>[], SellerCertificateDirectoryUnavailable>>;
}

export const SELLER_CERTIFICATE_DIRECTORY = Symbol('SELLER_CERTIFICATE_DIRECTORY');
