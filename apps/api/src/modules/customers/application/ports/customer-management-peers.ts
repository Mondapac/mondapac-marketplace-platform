import type { CallContext, Id, Result } from '@mondapac/shared-kernel';

// What the admin's management of a customer (phase 2) asks of `identity`, as the smallest
// interfaces it needs. The real facade satisfies them structurally; `CustomersReadModelsModule`
// binds it at start, and until then every call fails closed.

type Failure = { readonly code: string };

export interface IdentityManagementPeer {
  /**
   * An admin changes a customer account's display name (identity owns the write, the event and
   * its audit row). Rule `permissions [customers.customers.edit]`.
   */
  renameCustomerForAdmin(
    context: CallContext,
    input: { readonly accountId: Id<'Account'>; readonly displayName: string },
  ): Promise<Result<{ readonly changed: boolean }, Failure>>;
  /** The display names of admin accounts, for "who did it" (advisory). */
  changeActors(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<
    Result<
      readonly { readonly accountId: Id<'Account'>; readonly displayName: string | null }[],
      Failure
    >
  >;
  /** The calling admin's own panel zone (`timezone`), for day filters (ADR-0005). */
  describeActor(
    context: CallContext,
  ): Promise<Result<{ readonly timezone?: string | null }, Failure>>;
}

/** What the Customers search asks of `ordering` (phase 2b): who placed an order. */
export interface OrderAccountPeer {
  /** Rule `permissions [ordering.order.view]`; unknown and foreign ids `ordering.order-not-found`. */
  adminOrderAccountOf(
    context: CallContext,
    orderId: string,
  ): Promise<Result<{ readonly accountId: Id<'Account'> }, Failure>>;
}

export interface CustomerManagementPeers {
  readonly identity: IdentityManagementPeer;
  readonly ordering: OrderAccountPeer;
}

export const CUSTOMER_MANAGEMENT_PEERS = Symbol('CUSTOMER_MANAGEMENT_PEERS');
