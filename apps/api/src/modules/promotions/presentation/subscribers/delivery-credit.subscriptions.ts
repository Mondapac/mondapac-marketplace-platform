import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import { SellerOrderDelivered } from '../../../ordering';
import type { CashbackOnDelivery } from '../../application/use-cases/cashback-on-delivery.use-case';
import type { QualifyReferralOnDelivery } from '../../application/use-cases/qualify-referral-on-delivery.use-case';

/** The subscriber names: also the `handler` of `promotions.inbox`. */
export const CASHBACK_ON_DELIVERY_SUBSCRIBER = 'promotions.cashback-on-delivery';
export const QUALIFY_REFERRAL_ON_DELIVERY_SUBSCRIBER = 'promotions.qualify-referral-on-delivery';

/**
 * Promotions' subscriptions to `ordering.seller-order-delivered.v1` (phase 3): cashback and the
 * refer-a-friend reward. Entry adapters only: the decoded ids, the delivery and the Market's
 * system-actor context (the Market from the envelope) go unchanged to one `system` use case each.
 * A refusal throws, so the delivery is retried and, after its last attempt, dead-lettered with an
 * alert.
 */
export function deliveryCreditSubscriptions(
  cashback: CashbackOnDelivery,
  referral: QualifyReferralOnDelivery,
): RegisteredSubscription[] {
  return [
    subscription({
      name: CASHBACK_ON_DELIVERY_SUBSCRIBER,
      event: SellerOrderDelivered,
      handle: async (event, delivery, context) => {
        const result = await cashback.execute(context, {
          delivery,
          orderId: event.payload.orderId,
          sellerOrderId: event.payload.sellerOrderId,
        });
        if (!result.ok) {
          throw new Error(`${CASHBACK_ON_DELIVERY_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: QUALIFY_REFERRAL_ON_DELIVERY_SUBSCRIBER,
      event: SellerOrderDelivered,
      handle: async (event, delivery, context) => {
        const result = await referral.execute(context, {
          delivery,
          orderId: event.payload.orderId,
          sellerOrderId: event.payload.sellerOrderId,
        });
        if (!result.ok) {
          throw new Error(
            `${QUALIFY_REFERRAL_ON_DELIVERY_SUBSCRIBER} refused: ${result.error.code}`,
          );
        }
      },
    }),
  ];
}
