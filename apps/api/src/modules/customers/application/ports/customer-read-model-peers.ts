import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';

// What the customers read models ask of other modules, as the smallest interfaces they need.
// Declared here, not imported, because `customers` cannot import `ordering` without a file cycle
// (`ordering` imports `customers`). The real facades satisfy them structurally;
// `CustomersReadModelsModule` binds them at start, and until then every call fails closed.

type Failure = { readonly code: string };

export interface DirectoryRecordPeer {
  readonly accountId: Id<'Account'>;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: 'active' | 'disabled';
  readonly emailVerifiedAt: Temporal.Instant | null;
  readonly signedUpAt: Temporal.Instant;
}

export interface IdentityDirectoryPeer {
  customerDirectoryRecords(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<Result<readonly DirectoryRecordPeer[], Failure>>;
  customerDirectoryPage(
    context: CallContext,
    request: { readonly after: Id<'Account'> | null; readonly limit: number },
  ): Promise<Result<readonly DirectoryRecordPeer[], Failure>>;
}

export interface OrderStatsPeerValue {
  readonly accountId: Id<'Account'>;
  readonly orderCount: number;
  readonly firstOrderAt: Temporal.Instant | null;
  readonly lastOrderAt: Temporal.Instant | null;
  readonly spentMinor: bigint | null;
  readonly currency: string | null;
  readonly refundCount: number;
  readonly refundedMinor: bigint;
}

export interface OrderStatsPeer {
  customerOrderStats(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<OrderStatsPeerValue, Failure>>;
  customerOrderAccounts(
    context: CallContext,
    request: { readonly after: Id<'Account'> | null; readonly limit: number },
  ): Promise<Result<{ readonly accountIds: readonly Id<'Account'>[] }, Failure>>;
  /** The paying account of a confirmed order (ids only). */
  orderNotice(
    context: CallContext,
    orderId: string,
  ): Promise<Result<{ readonly accountId: Id<'Account'> }, Failure>>;
  /** The account a succeeded refund went back to (ids only for this use). */
  refundNotice(
    context: CallContext,
    request: { readonly orderId: string; readonly refundId: string },
  ): Promise<Result<{ readonly accountId: Id<'Account'>; readonly amount: Money }, Failure>>;
}

export interface SellerOrderTotalsPeerValue {
  readonly sellerId: Id<'Seller'>;
  readonly orderCount: number;
  readonly firstOrderAt: Temporal.Instant;
  readonly lastOrderAt: Temporal.Instant;
  readonly spentMinor: bigint;
  readonly currency: string;
}

export interface SellerCustomerOrderPeerValue {
  readonly sellerOrderId: string;
  readonly orderId: string;
  readonly paidAt: Temporal.Instant;
  readonly total: Money;
  readonly fulfilment: 'to-ship' | 'shipped' | 'delivered';
  readonly deliveredAt: Temporal.Instant | null;
}

/** What the per-seller customers read model (phase 3) asks of `ordering`. */
export interface SellerOrdersPeer {
  /** Rule `system`: the account's confirmed-order totals per seller. */
  customerSellerStats(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<readonly SellerOrderTotalsPeerValue[], Failure>>;
  /** As the calling seller: a page of their own paid seller orders of one customer. */
  sellerCustomerOrders(
    context: CallContext,
    request: {
      readonly accountId: Id<'Account'>;
      readonly page: number;
      readonly pageSize: number;
    },
  ): Promise<
    Result<
      { readonly items: readonly SellerCustomerOrderPeerValue[]; readonly total: number },
      Failure
    >
  >;
}

/** What the per-seller customers read model asks of `engagement`. */
export interface StoreFollowsPeer {
  /** Rule `system`: every store the account follows, with the instant the follow started. */
  followsOfAccount(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<
    Result<
      readonly { readonly sellerId: Id<'Seller'>; readonly followedAt: Temporal.Instant }[],
      Failure
    >
  >;
}

/** What the B1 read models (directory and stats) ask of the other modules. */
export interface ReadModelPeers {
  readonly identity: IdentityDirectoryPeer;
  readonly ordering: OrderStatsPeer;
}

/** Every peer, as `CustomersReadModelsModule` binds them. */
export interface CustomerReadModelPeers extends ReadModelPeers {
  readonly ordering: OrderStatsPeer & SellerOrdersPeer;
  readonly engagement: StoreFollowsPeer;
}

export const CUSTOMER_READ_MODEL_PEERS = Symbol('CUSTOMER_READ_MODEL_PEERS');
