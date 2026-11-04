import type { Id } from '@mondapac/shared-kernel';
import {
  OfferDeleted,
  OfferListingChanged,
  OfferMoved,
  OfferPublished,
  ProductPaused,
  ProductResumed,
  ProductRevisionPublished,
} from '../../../catalog';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { SyncOfferDocuments } from '../../application/use-cases/sync-offer-documents.use-case';

/** The subscriber names: also the `subscriber` of each delivery. */
export const INDEX_ON_OFFER_PUBLISHED_SUBSCRIBER = 'search.index-published-offer';
export const INDEX_ON_OFFER_DELETED_SUBSCRIBER = 'search.index-deleted-offer';
export const INDEX_ON_OFFER_MOVED_SUBSCRIBER = 'search.index-moved-offer';
export const INDEX_ON_REVISION_PUBLISHED_SUBSCRIBER = 'search.index-published-revision';
export const INDEX_ON_LISTING_CHANGED_SUBSCRIBER = 'search.index-listing-changed-offer';
export const INDEX_ON_PRODUCT_PAUSED_SUBSCRIBER = 'search.index-paused-product';
export const INDEX_ON_PRODUCT_RESUMED_SUBSCRIBER = 'search.index-resumed-product';

/**
 * Search's subscriptions to catalog (speed mode): an Offer published, deleted or moved, and a
 * product revision published (its text and categories changed for all of the product's Offers).
 * Each event only names what to look at; `SyncOfferDocuments` re-reads catalog, so no payload
 * content is trusted and a repeated or out-of-order delivery converges. Entry adapters: the
 * delivery's Market system-actor context goes unchanged to one `system` use case. A refusal
 * throws, so the delivery is retried and, after its last attempt, dead-lettered with an alert.
 * An Offer put on or taken off sale (`OfferListingChanged`) and a product paused or resumed
 * (the admin pause, catalog design 4.1a) re-read the Offer, or all Offers of the product, so a
 * paused product leaves the index at once and comes back on resume.
 * Variant changes need no subscription: the document holds nothing of variants.
 */
export function catalogIndexSubscriptions(sync: SyncOfferDocuments): RegisteredSubscription[] {
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
      name: INDEX_ON_OFFER_PUBLISHED_SUBSCRIBER,
      event: OfferPublished,
      handle: (event, _delivery, context) =>
        run(INDEX_ON_OFFER_PUBLISHED_SUBSCRIBER, context, {
          offerIds: [event.payload.offerId as Id<'Offer'>],
        }),
    }),
    subscription({
      name: INDEX_ON_OFFER_DELETED_SUBSCRIBER,
      event: OfferDeleted,
      handle: (event, _delivery, context) =>
        run(INDEX_ON_OFFER_DELETED_SUBSCRIBER, context, {
          offerIds: [event.payload.offerId as Id<'Offer'>],
        }),
    }),
    subscription({
      name: INDEX_ON_OFFER_MOVED_SUBSCRIBER,
      event: OfferMoved,
      handle: (event, _delivery, context) =>
        run(INDEX_ON_OFFER_MOVED_SUBSCRIBER, context, {
          offerIds: [event.payload.offerId as Id<'Offer'>],
        }),
    }),
    subscription({
      name: INDEX_ON_REVISION_PUBLISHED_SUBSCRIBER,
      event: ProductRevisionPublished,
      handle: (event, _delivery, context) =>
        run(INDEX_ON_REVISION_PUBLISHED_SUBSCRIBER, context, {
          productId: event.payload.productId as Id<'Product'>,
        }),
    }),
    subscription({
      name: INDEX_ON_LISTING_CHANGED_SUBSCRIBER,
      event: OfferListingChanged,
      handle: (event, _delivery, context) =>
        run(INDEX_ON_LISTING_CHANGED_SUBSCRIBER, context, {
          offerIds: [event.payload.offerId as Id<'Offer'>],
        }),
    }),
    subscription({
      name: INDEX_ON_PRODUCT_PAUSED_SUBSCRIBER,
      event: ProductPaused,
      handle: (event, _delivery, context) =>
        run(INDEX_ON_PRODUCT_PAUSED_SUBSCRIBER, context, {
          productId: event.payload.productId as Id<'Product'>,
        }),
    }),
    subscription({
      name: INDEX_ON_PRODUCT_RESUMED_SUBSCRIBER,
      event: ProductResumed,
      handle: (event, _delivery, context) =>
        run(INDEX_ON_PRODUCT_RESUMED_SUBSCRIBER, context, {
          productId: event.payload.productId as Id<'Product'>,
        }),
    }),
  ];
}
