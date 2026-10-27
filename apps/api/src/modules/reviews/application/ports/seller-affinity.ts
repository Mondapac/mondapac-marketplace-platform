import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * Whether the signed-in customer is tied to a seller they are about to review: a member of that
 * seller's team (the anti-abuse rule of the reviews package: nobody reviews their own shop). An
 * answer of `true` refuses the review; a failure to answer is thrown and fails the request
 * closed. A same-address or same-payment-fingerprint check, which only raises a signal, is
 * package 5 (see docs/modules/reviews/notes.md).
 */
export interface SellerAffinity {
  isTiedToSeller(
    context: CallContext,
    accountId: Id<'Account'>,
    sellerId: Id<'Seller'>,
  ): Promise<boolean>;
}

export const SELLER_AFFINITY = Symbol('SELLER_AFFINITY');
