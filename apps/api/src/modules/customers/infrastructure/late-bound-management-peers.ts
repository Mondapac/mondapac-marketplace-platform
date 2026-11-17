import { err } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type {
  CustomerManagementPeers,
  IdentityManagementPeer,
  OrderAccountPeer,
} from '../application/ports/customer-management-peers';

const UNAVAILABLE = () => Promise.resolve(err({ code: 'customers.unavailable' }));

/**
 * The peers of the admin's management of customers, refusing (fail closed) until
 * `CustomersReadModelsModule` binds the real `identity` and `ordering` facades at start.
 */
export class LateBoundManagementPeers implements CustomerManagementPeers {
  #bound: CustomerManagementPeers | null = null;

  bind(peers: CustomerManagementPeers): void {
    this.#bound = peers;
  }

  readonly identity: IdentityManagementPeer = {
    renameCustomerForAdmin: (
      context: CallContext,
      input: { readonly accountId: Id<'Account'>; readonly displayName: string },
    ) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.identity.renameCustomerForAdmin(context, input),
    changeActors: (context: CallContext, accountIds: readonly Id<'Account'>[]) =>
      this.#bound === null ? UNAVAILABLE() : this.#bound.identity.changeActors(context, accountIds),
    describeActor: (context: CallContext) =>
      this.#bound === null ? UNAVAILABLE() : this.#bound.identity.describeActor(context),
  };

  readonly ordering: OrderAccountPeer = {
    adminOrderAccountOf: (context: CallContext, orderId: string) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.ordering.adminOrderAccountOf(context, orderId),
  };
}
