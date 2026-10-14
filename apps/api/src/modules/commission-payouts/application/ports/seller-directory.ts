import type { CallContext, Id } from '@mondapac/shared-kernel';

/** Whether a seller exists in the context's Market (sellers' `sellerSummaries`, fail closed). */
export interface SellerDirectory {
  exists(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean | 'unavailable'>;
}

export const SELLER_DIRECTORY = Symbol('COMMISSION_PAYOUTS_SELLER_DIRECTORY');
