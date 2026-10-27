import type { CallContext } from '@mondapac/shared-kernel';
import type { OrderingFacade } from '../../ordering';
import type { OrderPaymentAnswer, OrderPaymentLookup } from '../application/ports/dispute-source';

/** {@link OrderPaymentLookup} on ordering's `orderPaymentRef`, read as the system actor. */
export class OrderingOrderPaymentLookup implements OrderPaymentLookup {
  constructor(private readonly ordering: OrderingFacade) {}

  async paymentIntentOf(
    context: CallContext,
    orderId: string,
  ): Promise<OrderPaymentAnswer | 'unavailable'> {
    const result = await this.ordering.orderPaymentRef(context, orderId);
    if (result.ok) return { known: true, paymentIntentId: result.value.paymentIntentId };
    return result.error.code === 'ordering.order-not-found' ? { known: false } : 'unavailable';
  }
}
