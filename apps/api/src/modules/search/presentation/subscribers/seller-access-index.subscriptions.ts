import type { Id } from '@mondapac/shared-kernel';
import { SellerAccessReinstated, SellerAccessSuspended } from '../../../identity';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { SyncOfferDocuments } from '../../application/use-cases/sync-offer-documents.use-case';

/** The subscriber names: also the `subscriber` of each delivery. */
export const UNINDEX_ON_SELLER_SUSPENDED_SUBSCRIBER = 'search.unindex-suspended-seller';
export const INDEX_ON_SELLER_REINSTATED_SUBSCRIBER = 'search.index-reinstated-seller';

/**
 * Search's subscriptions to identity's seller access (seller operations P-D): a suspended
 * seller's Offers leave the index, a reinstated seller's published Offers come back. Both only
 * name the seller; `SyncOfferDocuments` re-reads catalog and the may-sell contract, so a repeated
 * or out-of-order delivery converges on the seller's current state. A refusal throws, so the
 * delivery is retried. The public reads check the may-sell contract on every request too; this
 * keeps a suspended seller's matches from crowding search pages and shelves.
 */
export function sellerAccessIndexSubscriptions(sync: SyncOfferDocuments): RegisteredSubscription[] {
  const run = async (
    name: string,
    context: Parameters<SyncOfferDocuments['execute']>[0],
    sellerId: Id<'Seller'>,
  ): Promise<void> => {
    const result = await sync.execute(context, { sellerId });
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
  };
  return [
    subscription({
      name: UNINDEX_ON_SELLER_SUSPENDED_SUBSCRIBER,
      event: SellerAccessSuspended,
      handle: (event, _delivery, context) =>
        run(
          UNINDEX_ON_SELLER_SUSPENDED_SUBSCRIBER,
          context,
          event.payload.sellerId as Id<'Seller'>,
        ),
    }),
    subscription({
      name: INDEX_ON_SELLER_REINSTATED_SUBSCRIBER,
      event: SellerAccessReinstated,
      handle: (event, _delivery, context) =>
        run(INDEX_ON_SELLER_REINSTATED_SUBSCRIBER, context, event.payload.sellerId as Id<'Seller'>),
    }),
  ];
}
