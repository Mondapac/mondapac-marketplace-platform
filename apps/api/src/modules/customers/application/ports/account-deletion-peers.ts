import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';

// What the buyer deletion flow asks of other modules, as the smallest interfaces it needs. They are
// declared here, not imported, because `customers` cannot import `ordering` (or `wallet`) without a
// file cycle: `ordering` imports `customers`. The real facades satisfy them structurally;
// `CustomersAccountDeletionModule` binds them at start (as `SellerStoreProfileModule` binds
// certification), and until then every call fails closed.

type Failure = { readonly code: string };

/** The account an admin's deletion request names, as identity answers (ids only). */
export type CustomerAccountRefPeer = { readonly accountId: Id<'Account'> };

export interface OrderingPeer {
  ownOpenObligations(
    context: CallContext,
  ): Promise<Result<{ readonly openOrders: number; readonly pendingRefunds: number }, Failure>>;
  openObligationsOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly openOrders: number; readonly pendingRefunds: number }, Failure>>;
  /** The same counts for an admin's request for a buyer (package 5c; rule own-resources, admin). */
  adminOpenObligationsOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly openOrders: number; readonly pendingRefunds: number }, Failure>>;
}

export interface WalletPeer {
  ownBalanceOf(
    context: CallContext,
  ): Promise<Result<{ readonly available: Money; readonly held: Money }, Failure>>;
  balanceOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly available: Money; readonly held: Money }, Failure>>;
  /** The balance for an admin's request for a buyer (package 5c; rule own-resources, admin). */
  adminBalanceOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly available: Money; readonly held: Money }, Failure>>;
}

export interface IdentityPeer {
  endOtherCustomerSessions(
    context: CallContext,
  ): Promise<Result<{ readonly revokedSessions: number }, Failure>>;
  /** The active customer account of the admin's Market, else null (package 5c). */
  customerAccountOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<CustomerAccountRefPeer | null, Failure>>;
  /** Ends every session of the buyer for an admin's request (package 5c). */
  endCustomerSessionsForAdmin(
    context: CallContext,
    accountId: Id<'Account'>,
    requestId: Id<'AccountDeletionRequest'>,
  ): Promise<Result<{ readonly revokedSessions: number }, Failure>>;
  endAllCustomerSessions(
    context: CallContext,
    accountId: Id<'Account'>,
    requestId: Id<'AccountDeletionRequest'>,
  ): Promise<Result<{ readonly revokedSessions: number }, Failure>>;
  /** False once the account is erased: a claim is never handed back after that. */
  customerAccountExists(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly exists: boolean }, Failure>>;
  eraseCustomerAccount(
    context: CallContext,
    accountId: Id<'Account'>,
    requestId: Id<'AccountDeletionRequest'>,
  ): Promise<Result<{ readonly code: 'erased' | 'already-erased' }, Failure>>;
}

export interface EngagementPeer {
  forgetAccount(context: CallContext, accountId: Id<'Account'>): Promise<Result<unknown, Failure>>;
}

export interface ReviewsPeer {
  detachAuthor(context: CallContext, accountId: Id<'Account'>): Promise<Result<unknown, Failure>>;
}

export interface AccountDeletionPeers {
  readonly reviews: ReviewsPeer;
  readonly ordering: OrderingPeer;
  readonly wallet: WalletPeer;
  readonly identity: IdentityPeer;
  readonly engagement: EngagementPeer;
}

export const ACCOUNT_DELETION_PEERS = Symbol('ACCOUNT_DELETION_PEERS');
