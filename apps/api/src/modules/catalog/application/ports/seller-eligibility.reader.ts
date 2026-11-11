import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * The catalog's one question to `sellers`: may this seller sell? (it asks `sellingEligibility`,
 * the one may-sell contract; ADR-0022). A fault answers false (fail closed).
 */
export interface SellerEligibilityReader {
  isEligible(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean>;
}

export const SELLER_ELIGIBILITY_READER = Symbol('SELLER_ELIGIBILITY_READER');

/**
 * What a background job asks about its seller: the answer with the third state a job needs,
 * `unavailable` when the answer could not be read (a fault, not a "no"), so the job waits and
 * retries instead of acting on a refusal it never got.
 */
export interface SellerEligibilityStatusReader {
  status(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<'eligible' | 'not-eligible' | 'unavailable'>;
}

export const SELLER_ELIGIBILITY_STATUS_READER = Symbol('SELLER_ELIGIBILITY_STATUS_READER');
