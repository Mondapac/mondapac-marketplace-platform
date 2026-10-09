import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * Whether a seller may sell (catalog design 8.2 "sellingEligibility on every write"; sellers
 * design 7.2). Fails closed: `false` for an unknown seller and for any failure, never cached.
 */
export interface SellerEligibilityReader {
  isEligible(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean>;
}

export const SELLER_ELIGIBILITY_READER = Symbol('SELLER_ELIGIBILITY_READER');
