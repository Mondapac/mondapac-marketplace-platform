import type { Id } from '@mondapac/shared-kernel';
import { OfferDeleted, VariantRemoved } from '../../../catalog';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { RetireSeriesForRemovedOffer } from '../../application/use-cases/retire-series-for-removed-offer.use-case';
import type { RetireSeriesForRemovedVariant } from '../../application/use-cases/retire-series-for-removed-variant.use-case';

/** The subscriber names: also the `handler` of `pricing.inbox` (pricing-data 3.1). */
export const RETIRE_ON_OFFER_DELETED_SUBSCRIBER = 'pricing.retire-series-for-removed-offer';
export const RETIRE_ON_VARIANT_REMOVED_SUBSCRIBER = 'pricing.retire-series-for-removed-variant';

/**
 * Pricing's subscriptions to catalog's retirements (pricing design 6.4): an Offer that is deleted
 * retires its series; a Variant that is removed retires its series across every Offer (the event
 * names the product and the Variant, no Offer). Entry adapters: the delivery and the Market's
 * system-actor context go unchanged to one `system` use case. A refusal throws, so the delivery
 * is retried and, after its last attempt, dead-lettered with an alert (P 6.4).
 */
export function catalogRetirementSubscriptions(
  retireOffer: RetireSeriesForRemovedOffer,
  retireVariant: RetireSeriesForRemovedVariant,
): RegisteredSubscription[] {
  return [
    subscription({
      name: RETIRE_ON_OFFER_DELETED_SUBSCRIBER,
      event: OfferDeleted,
      async handle(event, delivery, context) {
        const result = await retireOffer.execute(context, {
          delivery,
          offerId: event.payload.offerId as Id<'Offer'>,
        });
        if (!result.ok) {
          throw new Error(`${RETIRE_ON_OFFER_DELETED_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: RETIRE_ON_VARIANT_REMOVED_SUBSCRIBER,
      event: VariantRemoved,
      async handle(event, delivery, context) {
        const result = await retireVariant.execute(context, {
          delivery,
          productId: event.payload.productId as Id<'Product'>,
          variantId: event.payload.variantId as Id<'Variant'>,
        });
        if (!result.ok) {
          throw new Error(`${RETIRE_ON_VARIANT_REMOVED_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}
