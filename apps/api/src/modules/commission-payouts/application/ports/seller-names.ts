import type { CallContext, Id } from '@mondapac/shared-kernel';

/** The public store names of sellers (sellers' `sellerSummaries`); a name may be missing. */
export interface SellerNames {
  /** At most 100 ids per call; `unavailable` when the read failed (callers degrade to ids). */
  storeNames(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, string | null> | 'unavailable'>;
}

export const SELLER_NAMES = Symbol('COMMISSION_PAYOUTS_SELLER_NAMES');
