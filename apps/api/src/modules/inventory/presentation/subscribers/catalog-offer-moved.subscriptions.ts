import type { Id } from '@mondapac/shared-kernel';
import { OfferMoved } from '../../../catalog';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { RekeyMovedOffer } from '../../application/use-cases/rekey-moved-offer.use-case';

/** The subscriber name: also the `handler` of `inventory.inbox` (data design 3.1). */
export const REKEY_ON_OFFER_MOVED_SUBSCRIBER = 'inventory.rekey-on-offer-moved';

/**
 * Inventory's subscription to catalog's `offer-moved` (inventory design 3.6): the stock of an Offer
 * that moved to a PLATFORM product follows its sell units to their new Variant ids. An entry
 * adapter: the delivery, the event's `aggregateVersion` and the Market's system-actor context go
 * unchanged to one `system` use case, which validates the mapping itself. A refusal throws, so the
 * delivery is retried and, after its last attempt, dead-lettered with an alert (P 6.4).
 */
export function catalogOfferMovedSubscriptions(rekey: RekeyMovedOffer): RegisteredSubscription[] {
  return [
    subscription({
      name: REKEY_ON_OFFER_MOVED_SUBSCRIBER,
      event: OfferMoved,
      async handle(event, delivery, context) {
        const { payload } = event;
        const result = await rekey.execute(context, {
          delivery,
          offerId: payload.offerId as Id<'Offer'>,
          fromProductId: payload.fromProductId as Id<'Product'>,
          toProductId: payload.toProductId as Id<'Product'>,
          fromVariantIds: payload.fromVariantIds as Id<'Variant'>[],
          toVariantIds: payload.toVariantIds as Id<'Variant'>[],
          sourceAggregateVersion: event.aggregateVersion,
        });
        if (!result.ok) {
          throw new Error(`${REKEY_ON_OFFER_MOVED_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}
