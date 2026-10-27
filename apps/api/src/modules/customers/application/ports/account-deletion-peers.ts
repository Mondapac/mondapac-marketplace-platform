import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';

// What the buyer deletion flow asks of other modules, as the smallest interfaces it needs. They are
// declared here, not imported, because `customers` cannot import `ordering` (or `wallet`) without a
// file cycle: `ordering` imports `customers`. The real facades satisfy them structurally;
// `CustomersAccountDeletionModule` binds them at start (as `SellerStoreProfileModule` binds
// certification), and until then every call fails closed.

type Failure = { readonly code: string };

export interface OrderingPeer {
  ownOpenObligations(
    context: CallContext,
  ): Promise<Result<{ readonly openOrders: number; readonly pendingRefunds: number }, Failure>>;
  openObligationsOf(
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
}

export interface IdentityPeer {
  endOtherCustomerSessions(
    context: CallContext,
  ): Promise<Result<{ readonly revokedSessions: number }, Failure>>;
  endAllCustomerSessions(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly revokedSessions: number }, Failure>>;
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
