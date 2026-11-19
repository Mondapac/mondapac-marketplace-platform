import { money } from '@mondapac/shared-kernel';
import type { OrderingFacade } from '../../ordering';
import type { Known } from '../application/ports/customer-facts';
import type {
  DeliveredOrderFacts,
  DeliveredSellerOrderFacts,
} from '../application/ports/order-facts';

/**
 * {@link DeliveredOrderFacts} on `ordering`'s facade (customers phase 4c). Only the system actor
 * (the delivery handlers) asks; any other caller and any failure is "unknown", so no credit is
 * issued on a guess. `ordering` has no synthetic orders, so no order is a test order.
 */
export class FacadeDeliveredOrderFacts implements DeliveredOrderFacts {
  constructor(private readonly ordering: OrderingFacade) {}

  async read(
    ...[context, request]: Parameters<DeliveredOrderFacts['read']>
  ): Promise<Known<DeliveredSellerOrderFacts>> {
    if (context.actor.kind !== 'system') return { known: false };
    const read = await this.ordering
      .deliveredSellerOrderFacts(context, request)
      .catch(() => ({ ok: false }) as const);
    if (!read.ok) return { known: false };
    const facts = read.value;
    return {
      known: true,
      value: {
        orderId: facts.orderId,
        sellerOrderId: facts.sellerOrderId,
        sellerId: facts.sellerId,
        customerAccountId: facts.customerAccountId,
        goodsPaid: money(
          facts.goods > facts.refundedGoods ? facts.goods - facts.refundedGoods : 0n,
          facts.currency,
        ),
        goodsKeptSettled: money(
          facts.goods > facts.succeededRefundedGoods
            ? facts.goods - facts.succeededRefundedGoods
            : 0n,
          facts.currency,
        ),
        exclusiveSeller: facts.exclusiveSeller,
        placedAt: facts.placedAt,
        deliveredAt: facts.deliveredAt,
        testOrder: false,
      },
    };
  }
}
