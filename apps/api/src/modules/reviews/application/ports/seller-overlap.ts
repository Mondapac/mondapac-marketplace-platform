import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { OverlapAnswers } from '../../domain/seller-overlap';

/**
 * The two yes or no answers for the same-address and same-payment-fingerprint signals (package 5):
 * did the buyer's order go to the seller's address, and did the buyer pay with a payment method of
 * the seller. The comparison is made by the owners of the data (ordering for the address, with at
 * least two shared address fields after folding case and spacing; payments for the fingerprint)
 * behind their facades; reviews never receives an address or a payment detail. Null means the
 * source cannot say (no signal). A failure to answer is thrown; the caller treats it as "no
 * signal", because a source that is down must never stop an honest buyer.
 */
export interface SellerOverlapSource {
  answersFor(
    context: CallContext,
    request: {
      readonly accountId: Id<'Account'>;
      readonly sellerId: Id<'Seller'>;
      readonly sellerOrderId: Id<'SellerOrder'>;
    },
  ): Promise<OverlapAnswers | null>;
}

export const SELLER_OVERLAP_SOURCE = Symbol('SELLER_OVERLAP_SOURCE');
