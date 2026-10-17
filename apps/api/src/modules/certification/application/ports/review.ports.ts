import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import type { ReviewPolicy } from '../../domain/review';
import type { VerificationMode } from '../../domain/type-revision';

// The small ports of the admin review that reach beyond the module's own tables.

/** The seller's business details as the reviewer reads them (personal data: never logged). */
export interface ReviewBusinessDetails {
  readonly businessName: string;
  readonly storeName: string;
  readonly operatingAddress: Readonly<Record<string, string>>;
  readonly registeredAddress: Readonly<Record<string, string>> | null;
}

export type BusinessDetailsAnswer =
  | { readonly status: 'ok'; readonly details: ReviewBusinessDetails }
  | { readonly status: 'not-found' | 'denied' | 'unavailable' };

/**
 * What the review reads from `sellers`: the public store names for the queue (an unknown seller
 * has none) and the reviewer's business details for the review page. Both pass the caller's
 * context unchanged; neither throws for a refusal.
 */
export interface ReviewSellerSource {
  storeNames(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string>>;
  businessDetails(context: CallContext, sellerId: Id<'Seller'>): Promise<BusinessDetailsAnswer>;
}

export const REVIEW_SELLER_SOURCE = Symbol('CERTIFICATION_REVIEW_SELLER_SOURCE');

/** The Market's review checks and reasons (design 5.1). Throws for a Market that has none. */
export interface ReviewPolicyProvider {
  policyFor(market: MarketContext): ReviewPolicy;
}

export const REVIEW_POLICY_PROVIDER = Symbol('CERTIFICATION_REVIEW_POLICY_PROVIDER');

/**
 * The keyed indexes of the duplicate hint (design 10.2): HMAC-SHA-256 under the module's stack
 * secret, with the Market and type in the input, over the normalised certificate number and over
 * the plaintext bytes of a file. 32 bytes each.
 */
export interface CertificateIndexKeys {
  numberHmac(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
    normalised: string,
  ): Uint8Array;
  documentHmac(market: MarketContext, typeId: Id<'CertificationType'>, bytes: Buffer): Uint8Array;
}

export const CERTIFICATE_INDEX_KEYS = Symbol('CERTIFICATION_CERTIFICATE_INDEX_KEYS');

/** Where the decision mail goes and from whom: the Market's sender and default locale. */
export interface CertificationMailPolicy {
  mailSender(market: MarketContext): { readonly address: string; readonly name: string };
}

export const CERTIFICATION_MAIL_POLICY = Symbol('CERTIFICATION_MAIL_POLICY');

export type { VerificationMode };
