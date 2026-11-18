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
 * Which of the given sellers' stores a customer follows, for the store-follower offer. `engagement`
 * owns store follows (customers management phase 3); a refusal is "unknown" and the offer is not
 * made (fail closed).
 */
export interface StoreFollows {
  followedAmong(
    context: CallContext,
    accountId: Id<'Account'>,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Known<readonly Id<'Seller'>[]>>;
}

export const STORE_FOLLOWS = Symbol('PROMOTIONS_STORE_FOLLOWS');

/**
 * Whether a customer is in one of the Market's manual customer groups, for the customer-group
 * discount of the manual-group segment. On `customers`' read facade (customers phase 2): the quote
 * asks as the Market's system actor. Any other caller, a refusal, an unknown or archived group is
 * "unknown" or "no": the discount is not offered (fail closed).
 */
export interface CustomerGroupMembership {
  isMember(
    context: CallContext,
    groupId: string,
    accountId: Id<'Account'>,
  ): Promise<Known<boolean>>;
}

export const CUSTOMER_GROUP_MEMBERSHIP = Symbol('PROMOTIONS_CUSTOMER_GROUP_MEMBERSHIP');

/**
 * The seller whose exclusive customer the account is at `at` (the customer joined through the
 * seller's invite link; customers phase 4a), for a seller's exclusive-customer discount. On
 * `customers`' read facade: the quote asks as the Market's system actor. Any other caller and any
 * failure is "unknown": the discount is not offered (fail closed).
 */
export interface ExclusiveCustomers {
  exclusiveSellerOf(
    context: CallContext,
    accountId: Id<'Account'>,
    at: Temporal.Instant,
  ): Promise<Known<Id<'Seller'> | null>>;
}

export const EXCLUSIVE_CUSTOMERS = Symbol('PROMOTIONS_EXCLUSIVE_CUSTOMERS');
