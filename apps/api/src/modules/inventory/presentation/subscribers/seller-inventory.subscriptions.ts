import { SellerRegistered } from '../../../identity';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { EnsureSellerInventory } from '../../application/use-cases/ensure-seller-inventory.use-case';

/** The subscriber name: also the `handler` of `inventory.inbox` (data design 3.1). */
export const ENSURE_SELLER_INVENTORY_SUBSCRIBER = 'inventory.ensure-seller-inventory';

/**
 * Inventory's subscription to `identity.seller-registered.v1` (inventory design 3.4, 7.4; slice
 * 1). An entry adapter: the dispatcher hands it the decoded event, the delivery and the Market's
 * system-actor context, which go unchanged to one `system` use case. A refusal throws, so the
 * delivery is retried and, after its last attempt, dead-lettered with an alert (P 6.4).
 */
export function sellerInventorySubscriptions(
  ensure: EnsureSellerInventory,
): RegisteredSubscription[] {
  return [
    subscription({
      name: ENSURE_SELLER_INVENTORY_SUBSCRIBER,
      event: SellerRegistered,
      async handle(event, delivery, context) {
        const result = await ensure.execute(context, {
          delivery,
          sellerId: event.payload.sellerId,
          accessState: event.payload.accessState,
        });
        if (!result.ok) {
          throw new Error(`${ENSURE_SELLER_INVENTORY_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}
