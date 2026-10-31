import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';

/** A fact another module owns: read, or not readable (unknown, never a guess). */
export type Known<T> = { readonly known: true; readonly value: T } | { readonly known: false };

/**
 * When a customer last ordered (the instant the last order was placed and paid), for the
 * customer-group discount of the returning-customer segment, and whether they have ordered at all
 * (for the refer-a-friend "new customer" check). `ordering` and `customers` publish no such read
 * yet, so the adapter answers "unknown"; the discount is then not offered and a referral is refused
 * (fail closed). Called before any unit opens, with the caller's context unchanged.
 */
export interface CustomerOrderHistory {
  /** `value: null`: the customer never ordered. */
  lastOrderAt(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Known<Temporal.Instant | null>>;
}

export const CUSTOMER_ORDER_HISTORY = Symbol('PROMOTIONS_CUSTOMER_ORDER_HISTORY');

/**
 * Which of the given sellers' stores a customer follows, for the store-follower offer. No module
 * owns a store follow yet (`engagement` has behaviour signals, `sellers` has stores, neither has
 * followers), so the adapter answers "unknown" and the offer is not made (fail closed).
 */
export interface StoreFollows {
  followedAmong(
    context: CallContext,
    accountId: Id<'Account'>,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Known<readonly Id<'Seller'>[]>>;
}

export const STORE_FOLLOWS = Symbol('PROMOTIONS_STORE_FOLLOWS');
