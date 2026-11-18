import type { CallContext, Id, Result } from '@mondapac/shared-kernel';

// What the invite links (customers management phase 4a) ask of other modules, as the smallest
// interfaces they need, bound at start by `CustomersReadModelsModule` (as the read model peers):
// every call fails closed until then.

type Failure = { readonly code: string };

export interface InvitationPeers {
  readonly identity: {
    /** Whether the signed-in customer's sign-in address is also a member's of the seller's team. */
    ownAccountTiedToSeller(
      context: CallContext,
      sellerId: Id<'Seller'>,
    ): Promise<Result<boolean, Failure>>;
  };
  readonly engagement: {
    /** The signed-in customer follows the store (the automatic follow after joining). */
    followStore(
      context: CallContext,
      sellerId: Id<'Seller'>,
    ): Promise<Result<{ readonly following: boolean }, Failure>>;
  };
  readonly sellers: {
    /** The address of each requested store the public can see now; others are absent. */
    publishedStoreSlugs(
      context: CallContext,
      sellerIds: readonly Id<'Seller'>[],
    ): Promise<Result<ReadonlyMap<Id<'Seller'>, string>, Failure>>;
  };
}

export const INVITATION_PEERS = Symbol('CUSTOMERS_INVITATION_PEERS');
