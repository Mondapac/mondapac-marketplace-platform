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
}

/** Nest token of the {@link CustomersReadFacade}, provided and exported by `CustomersModule`. */
export const CUSTOMERS_READ_FACADE = Symbol('CUSTOMERS_READ_FACADE');
