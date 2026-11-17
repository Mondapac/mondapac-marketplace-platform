import {
  subscription,
  type RegisteredSubscription,
  type SubscriberContext,
} from '../../../../platform/events/event-subscriptions';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { StoreFollowed, StoreUnfollowed } from '../../../engagement';
import { OrderPaid, RefundSucceeded } from '../../../ordering';
import type { SyncSellerCustomers } from '../../application/use-cases/sync-seller-customers.use-case';

/** The subscriber names: also the `handler` of the inbox. */
export const SELLER_CUSTOMERS_ORDER_PAID_SUBSCRIBER = 'customers.seller-customers-order-paid';
export const SELLER_CUSTOMERS_REFUND_SUBSCRIBER = 'customers.seller-customers-refund-succeeded';
export const SELLER_CUSTOMERS_FOLLOWED_SUBSCRIBER = 'customers.seller-customers-store-followed';
export const SELLER_CUSTOMERS_UNFOLLOWED_SUBSCRIBER = 'customers.seller-customers-store-unfollowed';

/**
 * The per-seller customers' subscriptions (customers management phase 3). Each hands the event's
 * ids, the delivery and the Market's system-actor context unchanged to `SyncSellerCustomers`,
 * which re-reads `ordering` and `engagement` and replaces the customer's rows, so a repeated or
 * late event is harmless. A refusal throws, so the delivery is retried and dead-lettered.
 */
export function sellerCustomersSubscriptions(sync: SyncSellerCustomers): RegisteredSubscription[] {
  const run = async (
    name: string,
    input:
      { readonly accountId: string } | { readonly orderId: string; readonly refundId?: string },
    delivery: EventDelivery,
    context: SubscriberContext,
  ): Promise<void> => {
    const result = await sync.execute(context, { ...input, delivery });
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
  };
  return [
    subscription({
      name: SELLER_CUSTOMERS_ORDER_PAID_SUBSCRIBER,
      event: OrderPaid,
      handle: (consumed, delivery, context) =>
        run(
          SELLER_CUSTOMERS_ORDER_PAID_SUBSCRIBER,
          { orderId: consumed.payload.orderId },
          delivery,
          context,
        ),
    }),
    subscription({
      name: SELLER_CUSTOMERS_REFUND_SUBSCRIBER,
      event: RefundSucceeded,
      handle: (consumed, delivery, context) =>
        run(
          SELLER_CUSTOMERS_REFUND_SUBSCRIBER,
          { orderId: consumed.payload.orderId, refundId: consumed.payload.refundId },
          delivery,
          context,
        ),
    }),
    subscription({
      name: SELLER_CUSTOMERS_FOLLOWED_SUBSCRIBER,
      event: StoreFollowed,
      handle: (consumed, delivery, context) =>
        run(
          SELLER_CUSTOMERS_FOLLOWED_SUBSCRIBER,
          { accountId: consumed.payload.accountId },
          delivery,
          context,
        ),
    }),
    subscription({
      name: SELLER_CUSTOMERS_UNFOLLOWED_SUBSCRIBER,
      event: StoreUnfollowed,
      handle: (consumed, delivery, context) =>
        run(
          SELLER_CUSTOMERS_UNFOLLOWED_SUBSCRIBER,
          { accountId: consumed.payload.accountId },
          delivery,
          context,
        ),
    }),
  ];
}
