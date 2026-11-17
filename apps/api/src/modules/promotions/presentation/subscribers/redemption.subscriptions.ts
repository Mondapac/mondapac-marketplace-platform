import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import { OrderCancelled, OrderPaid } from '../../../ordering';
import type { ConfirmRedemptions } from '../../application/use-cases/confirm-redemptions.use-case';
import type { ReleaseCancelledRedemptions } from '../../application/use-cases/release-cancelled-redemptions.use-case';

/** The subscriber names: also the `handler` of `promotions.inbox`. */
export const CONFIRM_REDEMPTIONS_SUBSCRIBER = 'promotions.confirm-redemptions';
export const RELEASE_CANCELLED_REDEMPTIONS_SUBSCRIBER = 'promotions.release-cancelled-redemptions';

/**
 * Promotions' subscriptions to the order's payment and cancellation (package T2). Entry adapters
 * only: the order id and the Market's system-actor context go unchanged to one `system` use case
 * each. A refusal throws, so the delivery is retried and, after its last attempt, dead-lettered
 * with an alert.
 */
export function redemptionSubscriptions(
  confirm: ConfirmRedemptions,
  release: ReleaseCancelledRedemptions,
): RegisteredSubscription[] {
  return [
    subscription({
      name: CONFIRM_REDEMPTIONS_SUBSCRIBER,
      event: OrderPaid,
      handle: async (event, delivery, context) => {
        const result = await confirm.execute(context, { delivery, orderId: event.payload.orderId });
        if (!result.ok) {
          throw new Error(`${CONFIRM_REDEMPTIONS_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: RELEASE_CANCELLED_REDEMPTIONS_SUBSCRIBER,
      event: OrderCancelled,
      handle: async (event, delivery, context) => {
        const result = await release.execute(context, { delivery, orderId: event.payload.orderId });
        if (!result.ok) {
          throw new Error(
            `${RELEASE_CANCELLED_REDEMPTIONS_SUBSCRIBER} refused: ${result.error.code}`,
          );
        }
      },
    }),
  ];
}
