import type { MarketContext } from '@mondapac/shared-kernel';

/** Where a manufacturer certificate number is kept: the root's draft or a revision. */
export type ProductNumberHolder = 'draft' | 'revision';

/**
 * The encryption of a manufacturer certificate's number and the keyed hash of a revision's
 * content (data design 3.15, 3.16, CE7): admin-recorded, no seller owns it, so both are under the
 * Market's platform subject (created on first use, never destroyed), each column with its own
 * label. Runs outside any unit. Plaintext never reaches a log, an event, an audit row or an error;
 * any failure throws.
 */
export interface ProductCertificateCipher {
  sealNumber(market: MarketContext, holder: ProductNumberHolder, number: string): Promise<string>;
  openNumber(market: MarketContext, holder: ProductNumberHolder, sealed: string): Promise<string>;
  /** `hmac-sha256:<64 hex>` of the canonical content of a revision. */
  contentHash(market: MarketContext, canonicalContent: string): Promise<string>;
}

export const PRODUCT_CERTIFICATE_CIPHER = Symbol('CERTIFICATION_PRODUCT_CERTIFICATE_CIPHER');
