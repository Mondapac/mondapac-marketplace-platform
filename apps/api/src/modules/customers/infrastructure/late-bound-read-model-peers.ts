import { err } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CustomerReadModelPeers } from '../application/ports/customer-read-model-peers';

const UNAVAILABLE = () => Promise.resolve(err({ code: 'customers.unavailable' }));

/**
 * The peers of the read models, refusing (fail closed) until `CustomersReadModelsModule` binds the
 * real `identity` and `ordering` facades at start.
 */
export class LateBoundReadModelPeers implements CustomerReadModelPeers {
  #bound: CustomerReadModelPeers | null = null;

  bind(peers: CustomerReadModelPeers): void {
    this.#bound = peers;
  }

  readonly identity = {
    customerDirectoryRecords: (context: CallContext, accountIds: readonly Id<'Account'>[]) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.identity.customerDirectoryRecords(context, accountIds),
    customerDirectoryPage: (
      context: CallContext,
      request: { readonly after: Id<'Account'> | null; readonly limit: number },
    ) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.identity.customerDirectoryPage(context, request),
  };

  readonly ordering = {
    customerOrderStats: (context: CallContext, accountId: Id<'Account'>) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.ordering.customerOrderStats(context, accountId),
    customerOrderAccounts: (
      context: CallContext,
      request: { readonly after: Id<'Account'> | null; readonly limit: number },
    ) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.ordering.customerOrderAccounts(context, request),
    orderNotice: (context: CallContext, orderId: string) =>
      this.#bound === null ? UNAVAILABLE() : this.#bound.ordering.orderNotice(context, orderId),
    refundNotice: (
      context: CallContext,
      request: { readonly orderId: string; readonly refundId: string },
    ) =>
      this.#bound === null ? UNAVAILABLE() : this.#bound.ordering.refundNotice(context, request),
  };
}
