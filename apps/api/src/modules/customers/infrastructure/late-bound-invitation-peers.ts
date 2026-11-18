import { err } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { InvitationPeers } from '../application/ports/invitation-peers';

const UNAVAILABLE = () => Promise.resolve(err({ code: 'customers.unavailable' }));

/**
 * The peers of the invite links, refusing (fail closed) until `CustomersReadModelsModule` binds the
 * real `identity`, `engagement` and `sellers` facades at start.
 */
export class LateBoundInvitationPeers implements InvitationPeers {
  #bound: InvitationPeers | null = null;

  bind(peers: InvitationPeers): void {
    this.#bound = peers;
  }

  readonly identity = {
    ownAccountTiedToSeller: (context: CallContext, sellerId: Id<'Seller'>) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.identity.ownAccountTiedToSeller(context, sellerId),
  };

  readonly engagement = {
    followStore: (context: CallContext, sellerId: Id<'Seller'>) =>
      this.#bound === null ? UNAVAILABLE() : this.#bound.engagement.followStore(context, sellerId),
  };

  readonly sellers = {
    publishedStoreSlugs: (context: CallContext, sellerIds: readonly Id<'Seller'>[]) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.sellers.publishedStoreSlugs(context, sellerIds),
  };
}
