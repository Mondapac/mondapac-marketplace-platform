import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { HANDLER_BUDGET_MS, type EventDelivery } from '../../../platform/events/event-delivery';
import { bookingMomentOf, type DeliveryAttention } from '../domain/delivery-method';
import { OrderShipped } from '../domain/events';
import {
  markDelivered,
  markNeedsAttention,
  markShipped,
  parseShipment,
  type OrderState,
  type SellerOrder,
} from '../domain/order';
import { refundedInFull } from '../domain/refund';
import type { OrderingDependencies } from './checkout-flow';
import { openShipTo } from './read-flow';

// Ordering's side of the real-time carrier (SHP-02/03): once an order is paid, each seller order
// is offered to shipping's `real_time_delivery` strategy; when the carrier reports progress,
// the shipment and the delivery are recorded as a seller would record them (SHP-01), so the
// "Shipped" email, inventory's shipment record and the ledger work unchanged. The customer's
// address is opened here and passed to shipping in process only: it is never logged or stored
// outside the sealed order.

const logger = new Logger('OrderingCarrierFlow');

/**
 * What one booking may take (the carrier call, at most 6 s by the Market config, and shipping's
 * units) and what the inbox unit needs at the end. A next seller order is started only while both
 * still fit in the handler budget; otherwise the delivery is retried and the seller orders
 * already booked answer `already-booked` at once.
 */
const ONE_BOOKING_MS = 8_000;
const INBOX_UNIT_MS = 7_000;

export type CarrierStepFailure =
  | { readonly code: 'validation.failed' }
  /** A temporary fault (shipping or the carrier is out of reach): the delivery is retried. */
  | { readonly code: 'ordering.try-again' };

export interface CarrierStepOutput {
  readonly code:
    | 'ordering.carrier.handled'
    | 'ordering.carrier.already-handled'
    | 'ordering.carrier.not-applicable';
}

const output = (handled: boolean, applied: boolean): CarrierStepOutput => ({
  code: !handled
    ? 'ordering.carrier.already-handled'
    : applied
      ? 'ordering.carrier.handled'
      : 'ordering.carrier.not-applicable',
});

/**
 * Books each of the seller orders with shipping's `real_time_delivery` strategy, in order, while
 * the handler budget lasts. Shipping decides whether a carrier takes one (and books once per seller
 * order), so a repeated call is harmless. A temporary fault stops the run and the delivery is
 * retried; the ones already booked answer `already-booked` the next time. An order no carrier can
 * take (`no-carrier`, `refused`) gets the platform-attention state: the seller never delivers
 * instead. Returns how many seller orders were newly booked.
 */
async function bookSellerOrders(
  deps: OrderingDependencies,
  context: CallContext,
  order: OrderState,
  sellerOrders: readonly SellerOrder[],
): Promise<Result<number, CarrierStepFailure>> {
  const { market } = context;
  let booked = 0;
  const shipTo = await openShipTo(deps, context, order.accountId, order.shipToSealed);
  // An erased account has no address left: nothing can be handed to a carrier.
  if (shipTo === null) return ok(booked);
  const started = deps.clock.now().epochMilliseconds;
  for (const [index, sellerOrder] of sellerOrders.entries()) {
    const elapsed = deps.clock.now().epochMilliseconds - started;
    if (index > 0 && elapsed + ONE_BOOKING_MS + INBOX_UNIT_MS > HANDLER_BUDGET_MS) {
      logger.warn({
        msg: 'ordering.carrier-booking-deferred',
        orderId: order.id,
        remaining: sellerOrders.length - index,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'ordering.try-again' });
    }
    // A seller order refunded in full (or on its way to it) is never handed to a carrier,
    // whichever of the refund and this delivery came first (Hassan H1).
    const target = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.refunds.findTarget(market, sellerOrder.id, order.id)),
      { readOnly: true },
    );
    if (!target.ok) return err({ code: 'ordering.try-again' });
    if (target.value !== null && refundedInFull(target.value, 'not-failed')) {
      logger.log({
        msg: 'ordering.carrier-booking-skipped-refunded',
        orderId: order.id,
        sellerOrderId: sellerOrder.id,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      continue;
    }
    const method = sellerOrder.deliveryMethod;
    // A pickup is never carried; the callers filter, this keeps the type honest.
    if (method === 'pickup') continue;
    const answer = await deps.shipping.bookCarrierDelivery(context, {
      orderId: order.id,
      sellerOrderId: sellerOrder.id,
      sellerId: sellerOrder.sellerId,
      service: {
        method,
        window:
          sellerOrder.deliveryWindow === null
            ? null
            : {
                start: sellerOrder.deliveryWindow.start.toString(),
                end: sellerOrder.deliveryWindow.end.toString(),
              },
      },
      dropoff: {
        contactName: `${shipTo.recipientFirstName} ${shipTo.recipientLastName}`.trim(),
        contactPhone: shipTo.phone,
        addressLines: [shipTo.line1, shipTo.line2 ?? '', shipTo.suburb, shipTo.region ?? ''],
        postcode: shipTo.postcode,
        // From the saved address the buyer picked at checkout, never free text.
        locality: shipTo.suburb,
        region: shipTo.region,
        notes: shipTo.deliveryNotes,
      },
      parcel: {
        itemCount: order.lines
          .filter((line) => line.sellerOrderId === sellerOrder.id)
          .reduce((count, line) => count + line.quantity, 0),
        declaredValueMinor: Number(sellerOrder.subtotal),
      },
    });
    if (!answer.ok) {
      logger.warn({
        msg: 'ordering.carrier-booking-failed',
        code: answer.error.code,
        orderId: order.id,
        sellerOrderId: sellerOrder.id,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      // A refused request will not pass later either: only a temporary fault is retried.
      if (answer.error.code === 'shipping.carrier-unavailable') {
        return err({ code: 'ordering.try-again' });
      }
      await recordAttention(deps, context, order.id, sellerOrder.id, 'no-carrier');
      continue;
    }
    if (answer.value === 'booked') booked += 1;
    if (answer.value === 'no-carrier' || answer.value === 'refused') {
      await recordAttention(deps, context, order.id, sellerOrder.id, 'no-carrier');
    }
    // A fleet that cannot dedupe went quiet: the order may be booked there, and it is never
    // booked again or given to another fleet, so an admin checks with the fleet.
    if (answer.value === 'unknown') {
      await recordAttention(deps, context, order.id, sellerOrder.id, 'carrier-unknown');
    }
  }
  return ok(booked);
}

/**
 * No carrier can take the seller order: it gets the "needs platform attention" state and a warn
 * line with ids only, for an admin to follow up. The seller is not asked to deliver. Written once
 * (a repeat finds it recorded); a failed write is logged and the delivery moves on, because a
 * retry would only ask the carrier the same question.
 */
async function recordAttention(
  deps: OrderingDependencies,
  context: CallContext,
  orderId: Id<'Order'>,
  sellerOrderId: Id<'SellerOrder'>,
  reason: DeliveryAttention,
): Promise<void> {
  const { market } = context;
  logger.warn({
    msg: 'ordering.delivery-needs-platform-attention',
    reason,
    orderId,
    sellerOrderId,
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  await deps.unitOfWork.run<true, never>(market, async () => {
    const fresh = await deps.orders.findById(market, orderId);
    const current = fresh?.sellerOrders.find((s) => s.id === sellerOrderId);
    const flagged = current === undefined ? null : markNeedsAttention(current, reason);
    if (flagged !== null) await deps.orders.saveAttention(market, flagged);
    return ok(true as const);
  });
}

/**
 * `book-carrier-deliveries`, for `ordering.order-paid.v1`: only the seller orders whose buyer
 * chose `scheduled` are booked now, for the buyer's window. Instant and same-day orders wait for
 * the seller to mark them ready ({@link bookReadyCarrierDelivery}); a pickup never books a
 * carrier. A temporary fault for any seller order fails the whole delivery, which comes due
 * again. The inbox mark is written last.
 */
export async function bookCarrierDeliveries(
  deps: OrderingDependencies,
  context: CallContext,
  input: { readonly delivery: EventDelivery; readonly orderId: unknown },
): Promise<Result<CarrierStepOutput, CarrierStepFailure>> {
  const orderId = typeof input?.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
  if (orderId === null || !orderId.ok) return err({ code: 'validation.failed' });
  const { market } = context;
  const read = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.orders.findById(market, orderId.value)),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'ordering.try-again' });
  const order = read.value;
  let booked = 0;
  const due =
    order?.sellerOrders.filter(
      (s) => s.fulfilment === 'to-ship' && bookingMomentOf(s.deliveryMethod) === 'payment',
    ) ?? [];
  if (order !== null && order.status === 'confirmed' && due.length > 0) {
    const done = await bookSellerOrders(deps, context, order, due);
    if (!done.ok) return done;
    booked = done.value;
  }
  const marked = await deps.unitOfWork.runOnce(market, input.delivery, () =>
    Promise.resolve(ok(undefined)),
  );
  if (!marked.ok) return err({ code: 'ordering.try-again' });
  return ok(output(marked.value.handled, booked > 0));
}

/**
 * `book-ready-carrier-delivery`, for `ordering.seller-order-ready.v1`: the seller said the order
 * is ready, so an `instant` or `same_day` seller order is booked with the carrier now. `scheduled`
 * was booked at payment and a pickup never books a carrier, so those are `not-applicable`. The
 * inbox mark is written last; a temporary fault retries the delivery.
 */
export async function bookReadyCarrierDelivery(
  deps: OrderingDependencies,
  context: CallContext,
  input: {
    readonly delivery: EventDelivery;
    readonly orderId: unknown;
    readonly sellerOrderId: unknown;
  },
): Promise<Result<CarrierStepOutput, CarrierStepFailure>> {
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
  const order = read.value;
  const sellerOrder = order?.sellerOrders.find((s) => s.id === sellerOrderId.value);
  let booked = 0;
  if (
    order !== null &&
    sellerOrder !== undefined &&
    order.status === 'confirmed' &&
    sellerOrder.fulfilment === 'to-ship' &&
    sellerOrder.readyAt !== null &&
    bookingMomentOf(sellerOrder.deliveryMethod) === 'ready'
  ) {
    const done = await bookSellerOrders(deps, context, order, [sellerOrder]);
    if (!done.ok) return done;
    booked = done.value;
  }
  const marked = await deps.unitOfWork.runOnce(market, input.delivery, () =>
    Promise.resolve(ok(undefined)),
  );
  if (!marked.ok) return err({ code: 'ordering.try-again' });
  return ok(output(marked.value.handled, booked > 0));
}

/**
 * `record-carrier-progress`, for `shipping.carrier-delivery-progressed.v1`: the current state of
 * the seller order's carrier delivery is read from shipping (so a late or repeated event acts on
 * today's state), then, in the inbox unit, picked up is recorded as shipped (carrier name and the
 * carrier's id as the tracking reference, with `ordering.order-shipped.v1`) and delivered as
 * delivered (shipped first when the pickup was never reported). An exception or a cancellation
 * changes nothing here: an admin follows it up.
 */
export async function recordCarrierProgress(
  deps: OrderingDependencies,
  context: CallContext,
  input: {
    readonly delivery: EventDelivery;
    readonly orderId: unknown;
    readonly sellerOrderId: unknown;
  },
): Promise<Result<CarrierStepOutput, CarrierStepFailure>> {
  const orderId = typeof input?.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
  const sellerOrderId =
    typeof input?.sellerOrderId === 'string' ? parseId<'SellerOrder'>(input.sellerOrderId) : null;
  if (orderId === null || !orderId.ok || sellerOrderId === null || !sellerOrderId.ok) {
    return err({ code: 'validation.failed' });
  }
  const { market } = context;
  const shipment = await deps.shipping.carrierShipment(context, sellerOrderId.value);
  if (!shipment.ok) {
    if (shipment.error.code === 'shipping.carrier-delivery-not-found') {
      return err({ code: 'validation.failed' });
    }
    return err({ code: 'ordering.try-again' });
  }
  const { progress } = shipment.value;
  const parsed = parseShipment({
    carrier: shipment.value.carrierName,
    trackingRef: shipment.value.trackingRef,
  });
  if (!parsed.ok) return err({ code: 'validation.failed' });
  const now = deps.clock.now();
  const marked = await deps.unitOfWork.runOnce<boolean, CarrierStepFailure>(
    market,
    input.delivery,
    async () => {
      if (progress !== 'picked-up' && progress !== 'delivered') return ok(false);
      const order = await deps.orders.findById(market, orderId.value);
      const current = order?.sellerOrders.find((s) => s.id === sellerOrderId.value);
      if (order === null || order.status !== 'confirmed' || current === undefined) {
        // The carrier moved a parcel of an order that is no longer confirmed (refunded meanwhile):
        // an admin must follow it up, so it is logged at warn with ids only.
        logger.warn({
          msg: 'ordering.carrier-progress-on-unconfirmed-order',
          progress,
          orderId: orderId.value,
          sellerOrderId: sellerOrderId.value,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        return ok(false);
      }
      let sellerOrder = current;
      let changed = false;
      if (sellerOrder.fulfilment === 'to-ship') {
        const shipped = markShipped(sellerOrder, parsed.shipment, now);
        if (shipped === null) return ok(false);
        if ((await deps.orders.saveFulfilment(market, shipped, 'to-ship')) !== 'saved') {
          return err({ code: 'ordering.try-again' });
        }
        await deps.outbox.append(
          context,
          [
            OrderShipped.record({
              aggregateId: shipped.id,
              aggregateVersion: 1,
              occurredAt: now,
              payload: { orderId: order.id, sellerOrderId: shipped.id, sellerId: shipped.sellerId },
            }),
          ],
          input.delivery.eventId,
        );
        sellerOrder = shipped;
        changed = true;
      }
      if (progress === 'delivered' && sellerOrder.fulfilment === 'shipped') {
        const delivered = markDelivered(sellerOrder, now);
        if (delivered === null) return ok(changed);
        if ((await deps.orders.saveFulfilment(market, delivered, 'shipped')) !== 'saved') {
          return err({ code: 'ordering.try-again' });
        }
        changed = true;
      }
      return ok(changed);
    },
  );
  if (!marked.ok) return marked;
  return ok(output(marked.value.handled, marked.value.handled && marked.value.value));
}

/**
 * `cancel-carrier-after-refund`, for `ordering.refund-succeeded.v1` (Hassan M2): once every unit
 * of a seller order is refunded, its real-time carrier delivery is cancelled if the carrier has
 * not picked it up yet. A partial refund leaves the delivery as it is. When the carrier can no
 * longer cancel (picked up meanwhile), the parcel is on its way although the money is back: that
 * is logged at warn with ids only for an admin. The inbox mark is written last.
 */
export async function cancelCarrierAfterRefund(
  deps: OrderingDependencies,
  context: CallContext,
  input: {
    readonly delivery: EventDelivery;
    readonly orderId: unknown;
    readonly sellerOrderId: unknown;
  },
): Promise<Result<CarrierStepOutput, CarrierStepFailure>> {
  const orderId = typeof input?.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
  const sellerOrderId =
    typeof input?.sellerOrderId === 'string' ? parseId<'SellerOrder'>(input.sellerOrderId) : null;
  if (orderId === null || !orderId.ok || sellerOrderId === null || !sellerOrderId.ok) {
    return err({ code: 'validation.failed' });
  }
  const { market } = context;
  const read = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.refunds.findTarget(market, sellerOrderId.value, orderId.value)),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'ordering.try-again' });
  const target = read.value;
  if (target === null) return err({ code: 'validation.failed' });
  let cancelled = false;
  // Only refunds Stripe confirmed count: a pending one may still fail, and the goods are owed.
  if (refundedInFull(target, 'succeeded')) {
    const answer = await deps.shipping.cancelCarrierDelivery(context, sellerOrderId.value);
    if (!answer.ok) {
      if (answer.error.code === 'validation.failed') return err({ code: 'validation.failed' });
      return err({ code: 'ordering.try-again' });
    }
    if (answer.value === 'not-cancellable') {
      logger.warn({
        msg: 'ordering.carrier-delivery-not-cancelled-after-refund',
        orderId: orderId.value,
        sellerOrderId: sellerOrderId.value,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    if (answer.value === 'none') {
      // No booking (yet): the booking step skips a seller order refunded in full.
      logger.log({
        msg: 'ordering.carrier-delivery-none-after-refund',
        orderId: orderId.value,
        sellerOrderId: sellerOrderId.value,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    if (answer.value === 'unknown') {
      // The fleet cannot dedupe, so its refusal does not say whether the parcel is still booked
      // although the money is back: an admin checks with the fleet.
      await recordAttention(deps, context, orderId.value, sellerOrderId.value, 'cancel-unknown');
    }
    cancelled = answer.value === 'cancelled';
  }
  const marked = await deps.unitOfWork.runOnce(market, input.delivery, () =>
    Promise.resolve(ok(undefined)),
  );
  if (!marked.ok) return err({ code: 'ordering.try-again' });
  return ok(output(marked.value.handled, cancelled));
}
