import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { OverlapFacts } from '../../domain/seller-overlap';

/**
 * The facts for the same-address and same-payment-fingerprint signals (package 5): where the
 * buyer's seller order went, which payment methods paid it, and the seller's own address and
 * payment methods. Null means the source cannot say (no signal is raised). A failure to answer is
 * thrown; the caller treats it as "no signal", because a source that is down must never stop an
 * honest buyer. The facts are compared and dropped; only a signal code is ever stored.
 */
export interface SellerOverlapSource {
  factsFor(
    context: CallContext,
    request: {
      readonly accountId: Id<'Account'>;
      readonly sellerId: Id<'Seller'>;
      readonly sellerOrderId: Id<'SellerOrder'>;
    },
  ): Promise<OverlapFacts | null>;
}

export const SELLER_OVERLAP_SOURCE = Symbol('SELLER_OVERLAP_SOURCE');
