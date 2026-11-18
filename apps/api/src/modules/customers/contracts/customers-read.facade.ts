import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

export type CustomerLastOrderFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  /** No read model row for the customer yet: unknown, and the caller treats it as "no". */
  | { readonly code: 'customers.customer-unknown' };

export type CustomerGroupMembershipFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  /** No such manual group in the caller's Market: the caller treats it as "not a member". */
  | { readonly code: 'customers.group-not-found' };

export type ExclusiveSellerFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  | { readonly code: 'customers.unavailable' };

/** The seller whose exclusive customer an account is, and since when (customers phase 4a). */
export interface ExclusiveSellerAnswer {
  readonly sellerId: Id<'Seller'>;
  readonly since: Temporal.Instant;
}

export type SellerOrderCustomersFailure =
  AccessDenied | { readonly code: 'validation.failed' } | { readonly code: 'access.unavailable' };

/**
 * A customer as one shop may know them on its own order pages: the customer's code for that shop
 * and their first name, nothing else (owner decision 2026-11-17).
 */
export interface SellerOrderCustomer {
  readonly code: string;
  /** The first word of the display name; null when the account has none. */
  readonly firstName: string | null;
}

/** What `customers` publishes to other modules about a customer's orders (ids and instants only). */
export interface CustomersReadFacade {
  /**
   * When the customer last had an order confirmed (placed and paid); `null` when they never did.
   * Rule `system`. A customer the read model does not know is `customers.customer-unknown`.
   */
  lastOrderAt(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly lastOrderAt: Temporal.Instant | null }, CustomerLastOrderFailure>>;

  /**
   * The signed-in customer's own last confirmed order, as {@link lastOrderAt}. Rule
   * `own-resources`; a customer session only (any other caller is refused).
   */
  ownLastOrderAt(
    context: CallContext,
  ): Promise<Result<{ readonly lastOrderAt: Temporal.Instant | null }, CustomerLastOrderFailure>>;

  /**
   * Whether the customer is in one of the Market's manual groups (an archived group has no
   * members for this answer). Rule `system`. An unknown group is `customers.group-not-found`;
   * a caller that gets any failure fails closed.
   */
  isGroupMember(
    context: CallContext,
    groupId: string,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly member: boolean }, CustomerGroupMembershipFailure>>;

  /**
   * The seller whose exclusive customer the account is at `at`: the customer joined through the
   * seller's invite link at or before `at`, and the attribution is active (customers phase 4a).
   * Null otherwise. Rule `system`; ids and an instant only. A caller that gets a failure treats the
   * customer as nobody's exclusive customer (fail closed).
   */
  exclusiveSellerOf(
    context: CallContext,
    accountId: Id<'Account'>,
    at: Temporal.Instant,
  ): Promise<Result<ExclusiveSellerAnswer | null, ExclusiveSellerFailure>>;

  /**
   * The calling shop's code and first name of each customer account, for the shop's own order
   * pages. Rule `permissions [ordering.seller-order.view]`, a seller session only (not a Login as
   * Seller session); at most 100 accounts. An account the shop has no customer row for is absent.
   */
  sellerOrderCustomers(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<Result<ReadonlyMap<Id<'Account'>, SellerOrderCustomer>, SellerOrderCustomersFailure>>;
}

/** Nest token of the {@link CustomersReadFacade}, provided and exported by `CustomersModule`. */
export const CUSTOMERS_READ_FACADE = Symbol('CUSTOMERS_READ_FACADE');
