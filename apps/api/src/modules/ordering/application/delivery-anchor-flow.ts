import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import type { OrderingDependencies } from './checkout-flow';

// Ordering's side of the payout eligibility anchor (Phase 5 package 6b). When a seller order is
// delivered, `commission-payouts` must freeze the instant its money becomes eligible: the delivery
// instant plus a hold that is shorter when the carrier confirmed the delivery than when only the
// seller's click did. Ordering owns those facts, so its own subscriber reads them and hands them
// to commission-payouts' facade (the same direction as the paid and refund facts: commission-payouts
// never imports ordering, which would be a circular dependency).

const logger = new Logger('OrderingDeliveryAnchorFlow');

export type DeliveryAnchorFailure =
  | { readonly code: 'validation.failed' }
  /** A temporary fault (the facts are not readable yet, shipping or commission-payouts refused): the delivery is retried. */
  | { readonly code: 'ordering.try-again' };

export interface DeliveryAnchorOutput {
  readonly code:
    | 'ordering.delivery-anchor.recorded'
    | 'ordering.delivery-anchor.already-handled'
    | 'ordering.delivery-anchor.not-delivered';
}

/**
 * `record-delivery-anchor`, for `ordering.seller-order-delivered.v1`: reads the seller order's
 * delivery from the order (the instant) and shipping (carrier-confirmed when the seller order's
 * carrier booking reached progress `delivered`; every other delivery, the seller's click and a
 * pickup handover included, is `seller-click`), tells commission-payouts, and marks the delivery
 * handled in the inbox unit last. commission-payouts writes the anchor once, so a repeat after a
 * crash changes nothing.
 */
export async function recordDeliveryAnchor(
  deps: OrderingDependencies,
  context: CallContext,
  input: {
    readonly delivery: EventDelivery;
    readonly orderId: unknown;
    readonly sellerOrderId: unknown;
  },
): Promise<Result<DeliveryAnchorOutput, DeliveryAnchorFailure>> {
  const orderId = typeof input?.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
  const sellerOrderId =
    typeof input?.sellerOrderId === 'string' ? parseId<'SellerOrder'>(input.sellerOrderId) : null;
  if (orderId === null || !orderId.ok || sellerOrderId === null || !sellerOrderId.ok) {
    return err({ code: 'validation.failed' });
  }
  const { market } = context;
  const read = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.orders.findById(market, orderId.value)),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'ordering.try-again' });
  const sellerOrder = read.value?.sellerOrders.find((s) => s.id === sellerOrderId.value);
  if (sellerOrder === undefined) return err({ code: 'validation.failed' });
  if (sellerOrder.fulfilment !== 'delivered' || sellerOrder.deliveredAt === null) {
    // The event is written in the unit that delivers, so this is a fault, not a normal case.
    logger.warn({
      msg: 'ordering.delivery-anchor-not-delivered',
      orderId: orderId.value,
      sellerOrderId: sellerOrderId.value,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'ordering.try-again' });
  }
  const shipment = await deps.shipping.carrierShipment(context, sellerOrderId.value);
  if (!shipment.ok && shipment.error.code !== 'shipping.carrier-delivery-not-found') {
    return err({ code: 'ordering.try-again' });
  }
  const source =
    shipment.ok && shipment.value.progress === 'delivered' ? 'carrier' : 'seller-click';
  const anchored = await deps.commission.recordSellerOrderDelivered(context, {
    orderId: orderId.value,
    sellerOrderId: sellerOrderId.value,
    sellerId: sellerOrder.sellerId,
    deliveredAt: sellerOrder.deliveredAt,
    source,
  });
  if (!anchored.ok) {
    logger.warn({
      msg: 'ordering.delivery-anchor-refused',
      code: anchored.error.code,
      orderId: orderId.value,
      sellerOrderId: sellerOrderId.value,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'ordering.try-again' });
  }
  const marked = await deps.unitOfWork.runOnce(market, input.delivery, () =>
    Promise.resolve(ok(undefined)),
  );
  if (!marked.ok) return err({ code: 'ordering.try-again' });
  return ok({
    code: marked.value.handled
      ? 'ordering.delivery-anchor.recorded'
      : 'ordering.delivery-anchor.already-handled',
  });
}
