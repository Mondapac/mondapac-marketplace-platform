import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

export type CustomerLastOrderFailure =
  | AccessDenied
  | { readonly code: 'validation.failed' }
  /** No read model row for the customer yet: unknown, and the caller treats it as "no". */
  | { readonly code: 'customers.customer-unknown' };

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
}

/** Nest token of the {@link CustomersReadFacade}, provided and exported by `CustomersModule`. */
export const CUSTOMERS_READ_FACADE = Symbol('CUSTOMERS_READ_FACADE');
