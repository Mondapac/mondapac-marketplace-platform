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
  validTypeCodes(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<Result<ReadonlySet<string>, SellerCertificateDirectoryUnavailable>>;
}

export const SELLER_CERTIFICATE_DIRECTORY = Symbol('SELLER_CERTIFICATE_DIRECTORY');
