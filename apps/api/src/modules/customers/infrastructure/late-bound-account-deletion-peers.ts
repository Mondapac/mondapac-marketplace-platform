import { err } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { AccountDeletionPeers } from '../application/ports/account-deletion-peers';

const UNAVAILABLE = () => Promise.resolve(err({ code: 'customers.unavailable' }));

/**
 * The peers of the deletion flow, refusing (fail closed) until `CustomersAccountDeletionModule`
 * binds the real facades at start. Every method forwards to the bound peer.
 */
export class LateBoundAccountDeletionPeers implements AccountDeletionPeers {
  #bound: AccountDeletionPeers | null = null;

  bind(peers: AccountDeletionPeers): void {
    this.#bound = peers;
  }

  readonly ordering = {
    ownOpenObligations: (context: CallContext) =>
      this.#bound === null ? UNAVAILABLE() : this.#bound.ordering.ownOpenObligations(context),
    openObligationsOf: (context: CallContext, accountId: Id<'Account'>) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.ordering.openObligationsOf(context, accountId),
  };
  readonly wallet = {
    ownBalanceOf: (context: CallContext) =>
      this.#bound === null ? UNAVAILABLE() : this.#bound.wallet.ownBalanceOf(context),
    balanceOf: (context: CallContext, accountId: Id<'Account'>) =>
      this.#bound === null ? UNAVAILABLE() : this.#bound.wallet.balanceOf(context, accountId),
  };
  readonly identity = {
    endOtherCustomerSessions: (context: CallContext) =>
      this.#bound === null ? UNAVAILABLE() : this.#bound.identity.endOtherCustomerSessions(context),
    endAllCustomerSessions: (context: CallContext, accountId: Id<'Account'>) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.identity.endAllCustomerSessions(context, accountId),
    eraseCustomerAccount: (
      context: CallContext,
      accountId: Id<'Account'>,
      requestId: Id<'AccountDeletionRequest'>,
    ) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.identity.eraseCustomerAccount(context, accountId, requestId),
  };
  readonly reviews = {
    detachAuthor: (context: CallContext, accountId: Id<'Account'>) =>
      this.#bound === null ? UNAVAILABLE() : this.#bound.reviews.detachAuthor(context, accountId),
  };
  readonly engagement = {
    forgetAccount: (context: CallContext, accountId: Id<'Account'>) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.engagement.forgetAccount(context, accountId),
  };
}
