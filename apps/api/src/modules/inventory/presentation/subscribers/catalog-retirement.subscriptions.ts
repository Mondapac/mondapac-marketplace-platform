import type { Id } from '@mondapac/shared-kernel';
import { OfferDeleted, VariantRemoved } from '../../../catalog';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { RetireSellUnits } from '../../application/use-cases/retire-sell-units.use-case';

/** The subscriber names: also the `handler` of `inventory.inbox` (data design 3.1). */
export const RETIRE_ON_OFFER_DELETED_SUBSCRIBER = 'inventory.retire-on-offer-deleted';
export const RETIRE_ON_VARIANT_REMOVED_SUBSCRIBER = 'inventory.retire-on-variant-removed';

/**
 * Inventory's subscriptions to catalog's retirements (inventory design 3.5): an Offer that is
 * deleted retires its items; a Variant that is removed retires its items across every Offer (the
 * event names the product and the Variant, no Offer). Entry adapters: the delivery, the event's
 * `aggregateVersion` and the Market's system-actor context go unchanged to one `system` use case.
 * A refusal throws, so the delivery is retried and, after its last attempt, dead-lettered with an
 * alert (P 6.4).
 */
export function catalogRetirementSubscriptions(retire: RetireSellUnits): RegisteredSubscription[] {
  return [
    subscription({
      name: RETIRE_ON_OFFER_DELETED_SUBSCRIBER,
      event: OfferDeleted,
      async handle(event, delivery, context) {
        const result = await retire.execute(context, {
          delivery,
          target: { scope: 'offer', offerId: event.payload.offerId as Id<'Offer'> },
          sourceAggregateVersion: event.aggregateVersion,
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
        const result = await retire.execute(context, {
          delivery,
          target: { scope: 'variant', variantId: event.payload.variantId as Id<'Variant'> },
          sourceAggregateVersion: event.aggregateVersion,
        });
        if (!result.ok) {
          throw new Error(`${RETIRE_ON_VARIANT_REMOVED_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}
