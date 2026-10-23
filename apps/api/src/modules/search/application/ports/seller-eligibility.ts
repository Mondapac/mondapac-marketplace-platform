import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * Which sellers may sell now (sellers' may-sell contract), asked by the index for the system
 * actor: a suspended seller's Offers get no document. `null` when the contract cannot answer;
 * the caller throws so the delivery or the rebuild page is retried.
 */
export interface SellerEligibility {
  eligible(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlySet<Id<'Seller'>> | null>;
}

export const SELLER_ELIGIBILITY = Symbol('SELLER_ELIGIBILITY');
