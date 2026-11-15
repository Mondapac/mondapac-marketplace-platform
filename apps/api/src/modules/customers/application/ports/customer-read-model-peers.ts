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

export interface CustomerReadModelPeers {
  readonly identity: IdentityDirectoryPeer;
  readonly ordering: OrderStatsPeer;
}

export const CUSTOMER_READ_MODEL_PEERS = Symbol('CUSTOMER_READ_MODEL_PEERS');
