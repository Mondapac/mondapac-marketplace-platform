import type { Id } from '@mondapac/shared-kernel';
import { PlatformCategoryChanged, PlatformCategoryMoved } from '../../../catalog';
import { SellerAccessApproved } from '../../../identity';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { SyncOfferDocuments } from '../../application/use-cases/sync-offer-documents.use-case';

/** The subscriber names: also the `subscriber` of each delivery. */
export const INDEX_ON_CATEGORY_CHANGED_SUBSCRIBER = 'search.index-changed-category';
export const INDEX_ON_CATEGORY_MOVED_SUBSCRIBER = 'search.index-moved-category';
export const INDEX_ON_SELLER_APPROVED_SUBSCRIBER = 'search.index-approved-seller';

/**
 * Search's subscriptions for the names a document is found by (search 1a): the category names of
 * every level and the seller's public store name sit in the document's searchable text. A category
 * changed (renamed) or moved (its ancestors changed) re-syncs the documents that name it or a
 * category under it; a seller approved re-syncs the seller's Offers, so a store name that came with
 * the approval is indexed. Each event only names what to look at; `SyncOfferDocuments` re-reads the
 * names, so repeated and out-of-order deliveries converge. A refusal throws, so the delivery is
 * retried. Today a public store name or address is set only by the onboarding approval (covered by
 * the approval event). When sellers builds the identity-change approval, the admin identity edit and
 * the admin address change (sellers design 7.4), their events are subscribed here; until then the
 * six-hourly rebuild is the repair.
 */
export function namesIndexSubscriptions(sync: SyncOfferDocuments): RegisteredSubscription[] {
  const run = async (
    name: string,
    context: Parameters<SyncOfferDocuments['execute']>[0],
    input: Parameters<SyncOfferDocuments['execute']>[1],
  ): Promise<void> => {
    const result = await sync.execute(context, input);
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
  };
  return [
    subscription({
      name: INDEX_ON_CATEGORY_CHANGED_SUBSCRIBER,
      event: PlatformCategoryChanged,
      handle: (event, _delivery, context) =>
        run(INDEX_ON_CATEGORY_CHANGED_SUBSCRIBER, context, {
          categoryId: event.payload.categoryId as Id<'Category'>,
        }),
    }),
    subscription({
      name: INDEX_ON_CATEGORY_MOVED_SUBSCRIBER,
      event: PlatformCategoryMoved,
      handle: (event, _delivery, context) =>
        run(INDEX_ON_CATEGORY_MOVED_SUBSCRIBER, context, {
          categoryId: event.payload.categoryId as Id<'Category'>,
        }),
    }),
    subscription({
      name: INDEX_ON_SELLER_APPROVED_SUBSCRIBER,
      event: SellerAccessApproved,
      handle: (event, _delivery, context) =>
        run(INDEX_ON_SELLER_APPROVED_SUBSCRIBER, context, {
          sellerId: event.payload.sellerId as Id<'Seller'>,
        }),
    }),
  ];
}
