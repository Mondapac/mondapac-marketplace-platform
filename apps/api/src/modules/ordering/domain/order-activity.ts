import { money, Temporal } from '@mondapac/shared-kernel';
import type { Id, Money } from '@mondapac/shared-kernel';
import type { CancelReason, OrderState, SellerOrder } from './order';
import type { Refund, RefundReason } from './refund';

// The order activity timeline (order detail, panels row 4): a read-only list of what happened to
// an order, derived from the instants ordering already stores (no table of its own, nothing
// written). Each panel sees only what its role may see:
// - the admin page: the whole order (placed, paid or cancelled), every seller order's steps and
//   every refund;
// - the seller page: one seller order only, from the moment it was paid (a seller never sees an
//   unpaid order), its own steps and its own refunds. Never another seller's seller order, an
//   admin note, a customer's name or address, an account id, a Stripe id or a loss reason code.
// Instants are UTC; each panel renders them in its viewer's zone. Ties keep a fixed order (the
// step order below, then the ids), so the same data always gives the same list.

/** What happened. */
export type OrderActivityKind =
  /** The customer placed the order (checkout started; admin only). */
  | 'order-placed'
  /** The payment was confirmed: the order (admin) or the seller order (seller) became paid. */
  | 'order-paid'
  /** The order was cancelled before it was paid (expired, payment failed, ...; admin only). */
  | 'order-cancelled'
  /** The seller told the platform the seller order is ready. */
  | 'seller-order-ready'
  /** The seller order left the shop (taken by the carrier). */
  | 'seller-order-shipped'
  /** The seller order was delivered to the customer. */
  | 'seller-order-delivered'
  /** The customer collected a pickup order at the shop (the seller typed the pickup code). */
  | 'seller-order-collected'
  /** A refund was asked for (an admin's, or the seller's unavailable units). */
  | 'refund-requested'
  /** Stripe gave the money back. */
  | 'refund-succeeded'
  /** Stripe refused the refund: nothing went back. */
  | 'refund-failed';

/** Who did it, when the stored data says so; null when it was the platform or a carrier. */
export type OrderActivityActor = 'customer' | 'seller' | 'admin';

/** One entry of the timeline. */
export interface OrderActivityEvent {
  readonly kind: OrderActivityKind;
  /** When it happened (UTC). */
  readonly at: Temporal.Instant;
  /** The seller order it is about; null for an event of the whole order. */
  readonly sellerOrderId: Id<'SellerOrder'> | null;
  /** The refund it is about; null for any other event. */
  readonly refundId: Id<'Refund'> | null;
  /** A refund's amount (what goes back to the customer, tax included); null otherwise. */
  readonly amount: Money | null;
  /** The refund reason or the cancel reason (closed lists); null otherwise. */
  readonly reason: RefundReason | CancelReason | null;
  readonly by: OrderActivityActor | null;
}

/** The step order that breaks ties between events of the same instant. */
const RANK: Readonly<Record<OrderActivityKind, number>> = {
  'order-placed': 0,
  'order-cancelled': 1,
  'order-paid': 2,
  'seller-order-ready': 3,
  'seller-order-shipped': 4,
  'seller-order-collected': 5,
  'seller-order-delivered': 6,
  'refund-requested': 7,
  'refund-succeeded': 8,
  'refund-failed': 9,
};

const event = (
  kind: OrderActivityKind,
  at: Temporal.Instant,
  patch: Partial<Omit<OrderActivityEvent, 'kind' | 'at'>> = {},
): OrderActivityEvent => ({
  kind,
  at,
  sellerOrderId: null,
  refundId: null,
  amount: null,
  reason: null,
  by: null,
  ...patch,
});

/** The steps of one seller order after it was paid. */
function sellerOrderSteps(sellerOrder: SellerOrder): OrderActivityEvent[] {
  const of = { sellerOrderId: sellerOrder.id };
  const steps: OrderActivityEvent[] = [];
  if (sellerOrder.readyAt !== null) {
    steps.push(event('seller-order-ready', sellerOrder.readyAt, { ...of, by: 'seller' }));
  }
  if (sellerOrder.shippedAt !== null) {
    steps.push(event('seller-order-shipped', sellerOrder.shippedAt, of));
  }
  if (sellerOrder.deliveredAt !== null) {
    // A pickup order is delivered when the seller confirms the handover with the buyer's code.
    steps.push(
      sellerOrder.deliveryMethod === 'pickup'
        ? event('seller-order-collected', sellerOrder.deliveredAt, { ...of, by: 'seller' })
        : event('seller-order-delivered', sellerOrder.deliveredAt, of),
    );
  }
  return steps;
}

/** A refund's request and, once Stripe answered, its outcome. */
function refundSteps(refund: Refund): OrderActivityEvent[] {
  const of = {
    sellerOrderId: refund.sellerOrderId,
    refundId: refund.id,
    amount: money(refund.gross, refund.currency),
    reason: refund.reason,
  };
  const steps = [
    event('refund-requested', refund.requestedAt, { ...of, by: refund.actor.population }),
  ];
  if (refund.settledAt !== null && refund.state !== 'pending') {
    steps.push(
      event(
        refund.state === 'succeeded' ? 'refund-succeeded' : 'refund-failed',
        refund.settledAt,
        of,
      ),
    );
  }
  return steps;
}

/** Code-unit order (never the locale's): ids are lower-case hex UUIDs. */
const byId = (a: string | null, b: string | null): number => {
  const x = a ?? '';
  const y = b ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
};

function ordered(events: OrderActivityEvent[]): readonly OrderActivityEvent[] {
  return events.sort(
    (a, b) =>
      Temporal.Instant.compare(a.at, b.at) ||
      RANK[a.kind] - RANK[b.kind] ||
      byId(a.sellerOrderId, b.sellerOrderId) ||
      byId(a.refundId, b.refundId),
  );
}

/**
 * The admin timeline of a whole order, oldest first: placed, paid or cancelled, each seller
 * order's steps and every refund of the order (a refund of another order is ignored).
 */
export function orderActivity(
  order: OrderState,
  refunds: readonly Refund[],
): readonly OrderActivityEvent[] {
  const events: OrderActivityEvent[] = [event('order-placed', order.createdAt, { by: 'customer' })];
  if (order.confirmedAt !== null) events.push(event('order-paid', order.confirmedAt));
  if (order.status === 'cancelled' && order.cancelledAt !== null) {
    events.push(event('order-cancelled', order.cancelledAt, { reason: order.cancelReason }));
  }
  for (const sellerOrder of order.sellerOrders) events.push(...sellerOrderSteps(sellerOrder));
  for (const refund of refunds) {
    if (refund.orderId === order.id) events.push(...refundSteps(refund));
  }
  return ordered(events);
}

/**
 * The seller timeline of one paid seller order, oldest first: paid, its steps and its own
 * refunds. A refund of any other seller order is ignored, so nothing of another shop can leak.
 */
export function sellerOrderActivity(
  record: { readonly sellerOrder: SellerOrder; readonly confirmedAt: Temporal.Instant },
  refunds: readonly Refund[],
): readonly OrderActivityEvent[] {
  const { sellerOrder } = record;
  const events: OrderActivityEvent[] = [
    event('order-paid', record.confirmedAt, { sellerOrderId: sellerOrder.id }),
    ...sellerOrderSteps(sellerOrder),
  ];
  for (const refund of refunds) {
    if (refund.sellerOrderId === sellerOrder.id && refund.sellerId === sellerOrder.sellerId) {
      events.push(...refundSteps(refund));
    }
  }
  return ordered(events);
}
