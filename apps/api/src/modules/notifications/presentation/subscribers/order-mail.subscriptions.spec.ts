import { err, ok } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { SubscriberContext } from '../../../../platform/events/event-subscriptions';
import type { SendOrderConfirmationMail } from '../../application/use-cases/send-order-confirmation-mail.use-case';
import type { SendOrderShippedMail } from '../../application/use-cases/send-order-shipped-mail.use-case';
import type { SendSellerNewOrderMail } from '../../application/use-cases/send-seller-new-order-mail.use-case';
import { orderMailSubscriptions } from './order-mail.subscriptions';

// A refused use case must throw out of the subscriber, so the dispatcher retries the delivery
// and dead-letters it after the last attempt; it must never be swallowed.

const refusing = { execute: () => Promise.resolve(err({ code: 'access.denied' })) };
const accepting = { execute: () => Promise.resolve(ok({ code: 'order-mail.sent', sent: 1 })) };
const delivery = {} as EventDelivery;
const context = {} as SubscriberContext;
const envelope = {
  payload: { orderId: 'o', sellerOrderId: 's', sellerId: 'x' },
} as never;

describe('order mail subscriptions', () => {
  it('throws when the use case refuses, for every subscriber', async () => {
    const subscriptions = orderMailSubscriptions(
      refusing as unknown as SendOrderConfirmationMail,
      refusing as unknown as SendSellerNewOrderMail,
      refusing as unknown as SendOrderShippedMail,
    );
    expect(subscriptions.map((s) => s.name)).toContain('notifications.order-shipped-mail');
    for (const subscription of subscriptions) {
      await expect(subscription.handle(envelope, delivery, context)).rejects.toThrow(/refused/);
    }
  });

  it('resolves when the use case answers', async () => {
    const subscriptions = orderMailSubscriptions(
      accepting as unknown as SendOrderConfirmationMail,
      accepting as unknown as SendSellerNewOrderMail,
      accepting as unknown as SendOrderShippedMail,
    );
    for (const subscription of subscriptions) {
      await expect(subscription.handle(envelope, delivery, context)).resolves.toBeUndefined();
    }
  });
});
