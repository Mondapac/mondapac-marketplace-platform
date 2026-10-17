import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * Where a seller's decision mail goes: the Owner's sign-in address through `identity`'s contact
 * point (request R-4). Personal data: used for one send and never logged, stored or put in an
 * event. `null` when there is none to use (unknown, disabled, not verified, all alike). A refusal
 * or a fault throws, so the delivery is retried.
 */
export interface SellerOwnerContact {
  emailOf(context: CallContext, sellerId: Id<'Seller'>): Promise<string | null>;
}

export const SELLER_OWNER_CONTACT = Symbol('CERTIFICATION_SELLER_OWNER_CONTACT');
