import type { Id, MarketId, Money, Temporal } from '@mondapac/shared-kernel';

// The order aggregate and the pure rules around it (ordering design, simplified for speed mode).
// Money is integer minor units plus a currency; prices are GST-inclusive as pricing gives them.

/** One buyable cart line as planning needs it (structurally the cart's checkout line). */
export interface CheckoutLine {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
  readonly state: 'buyable' | 'unavailable' | 'check-unavailable';
  readonly sellerId: Id<'Seller'> | null;
  readonly unitPrice: Money | null;
  readonly taxInclusive: boolean | null;
}

export type OrderStatus = 'pending-payment' | 'confirmed' | 'cancelled';
/** `none`: no money moved; `authorised`: held on the card; `captured`: taken; `voided`: released. */
export type PaymentState = 'none' | 'authorised' | 'captured' | 'voided';
export type CancelReason =
  'expired' | 'payment-failed' | 'stock-unavailable' | 'superseded' | 'provider-failed';

export interface OrderLine {
  readonly id: Id<'OrderLine'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly lineAmount: bigint;
  readonly taxInclusive: boolean;
  readonly reservationLineId: string;
}

/** Where a seller order stands once it is paid: `to-ship`, then `shipped`, then `delivered`. */
export type Fulfilment = 'to-ship' | 'shipped' | 'delivered';

/**
 * The part of an order that belongs to one seller. `shipping` is the seller's flat fee as it was
 * when the order was placed (SHP-01), part of `total`. The seller records the shipment (carrier
 * and an optional tracking reference) and then the delivery, each once and in that order.
 */
export interface SellerOrder {
  readonly id: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly subtotal: bigint;
  readonly shipping: bigint;
  readonly total: bigint;
  readonly fulfilment: Fulfilment;
  readonly carrier: string | null;
  readonly trackingRef: string | null;
  readonly shippedAt: Temporal.Instant | null;
  readonly deliveredAt: Temporal.Instant | null;
  /** When inventory was told the lines left the warehouse; null until the worker did it. */
  readonly inventoryRecordedAt: Temporal.Instant | null;
}

export interface OrderState {
  readonly id: Id<'Order'>;
  readonly marketId: MarketId;
  readonly accountId: Id<'Account'>;
  readonly status: OrderStatus;
  readonly cancelReason: CancelReason | null;
  readonly paymentState: PaymentState;
  readonly total: Money;
  readonly reservationId: string;
  readonly stripeIdempotencyKey: string;
  readonly stripeSessionId: string | null;
  readonly stripePaymentIntentId: string | null;
  readonly paymentExpiresAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
  readonly confirmedAt: Temporal.Instant | null;
  readonly cancelledAt: Temporal.Instant | null;
  readonly version: number;
  readonly sellerOrders: readonly SellerOrder[];
  readonly lines: readonly OrderLine[];
}

/** One cart line grouped under its seller, ready to become an order line. */
export interface PlannedLine {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly taxInclusive: boolean;
}

export interface PlannedSeller {
  readonly sellerId: Id<'Seller'>;
  readonly lines: readonly PlannedLine[];
  readonly subtotal: bigint;
  /** The seller's flat shipping fee; 0 until {@link addShipping} sets it. */
  readonly shipping: bigint;
}

/** `total` is the sum of the seller totals (goods plus shipping). */
export interface Plan {
  readonly currency: string;
  readonly sellers: readonly PlannedSeller[];
  readonly total: bigint;
}

export type PlanFailure =
  | { readonly code: 'ordering.cart-empty' }
  | {
      readonly code: 'ordering.cart-not-purchasable';
      /** Zero-based positions of the lines that cannot be bought now. */
      readonly lineIndexes: readonly number[];
    }
  /** A line check could not be made (fail closed); the customer may try again. */
  | { readonly code: 'ordering.check-unavailable' };

/**
 * Turns the cart lines into sellers with their lines and totals. Every line must be buyable with
 * a positive price in one currency, else nothing is planned (checkout never drops a line
 * silently). Sellers are ordered by id and lines by Offer and Variant, so the same cart always
 * gives the same order of rows.
 */
export function planOrder(
  lines: readonly CheckoutLine[],
  limits: { readonly maxLines: number },
):
  { readonly ok: true; readonly plan: Plan } | { readonly ok: false; readonly error: PlanFailure } {
  if (lines.length === 0) return { ok: false, error: { code: 'ordering.cart-empty' } };
  if (lines.length > limits.maxLines) {
    return { ok: false, error: { code: 'ordering.cart-not-purchasable', lineIndexes: [] } };
  }
  if (lines.some((line) => line.state === 'check-unavailable')) {
    return { ok: false, error: { code: 'ordering.check-unavailable' } };
  }
  const bad: number[] = [];
  lines.forEach((line, index) => {
    if (
      line.state !== 'buyable' ||
      line.sellerId === null ||
      line.unitPrice === null ||
      line.unitPrice.amount <= 0n ||
      line.taxInclusive === null ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1
    ) {
      bad.push(index);
    }
  });
  const currency = lines.find((line) => line.unitPrice !== null)?.unitPrice?.currency;
  if (currency !== undefined) {
    lines.forEach((line, index) => {
      if (line.unitPrice !== null && line.unitPrice.currency !== currency && !bad.includes(index)) {
        bad.push(index);
      }
    });
  }
  if (bad.length > 0 || currency === undefined) {
    return {
      ok: false,
      error: { code: 'ordering.cart-not-purchasable', lineIndexes: bad.sort((a, b) => a - b) },
    };
  }
  const bySeller = new Map<string, PlannedLine[]>();
  for (const line of lines) {
    const group = bySeller.get(line.sellerId!) ?? [];
    group.push({
      offerId: line.offerId,
      variantId: line.variantId,
      quantity: line.quantity,
      unitPrice: line.unitPrice!,
      taxInclusive: line.taxInclusive!,
    });
    bySeller.set(line.sellerId!, group);
  }
  const sellers: PlannedSeller[] = [...bySeller]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sellerId, group]) => {
      const sorted = [...group].sort(
        (a, b) => a.offerId.localeCompare(b.offerId) || a.variantId.localeCompare(b.variantId),
      );
      return {
        sellerId: sellerId as Id<'Seller'>,
        lines: sorted,
        subtotal: sorted.reduce((sum, l) => sum + l.unitPrice.amount * BigInt(l.quantity), 0n),
        shipping: 0n,
      };
    });
  const total = sellers.reduce((sum, seller) => sum + seller.subtotal, 0n);
  return { ok: true, plan: { currency, sellers, total } };
}

/**
 * Adds each seller's flat shipping fee to the plan. A seller without a fee, or with a fee in
 * another currency, fails the whole plan (fail closed): the customer is never charged a guess.
 * An explicit zero is a fee.
 */
export function addShipping(
  plan: Plan,
  fees: ReadonlyMap<Id<'Seller'>, Money>,
):
  | { readonly ok: true; readonly plan: Plan }
  | { readonly ok: false; readonly sellerIds: readonly Id<'Seller'>[] } {
  const missing = plan.sellers
    .filter((seller) => {
      const fee = fees.get(seller.sellerId);
      return fee === undefined || fee.currency !== plan.currency || fee.amount < 0n;
    })
    .map((seller) => seller.sellerId);
  if (missing.length > 0) return { ok: false, sellerIds: missing };
  const sellers = plan.sellers.map((seller) => ({
    ...seller,
    shipping: fees.get(seller.sellerId)!.amount,
  }));
  const total = sellers.reduce((sum, seller) => sum + seller.subtotal + seller.shipping, 0n);
  return { ok: true, plan: { ...plan, sellers, total } };
}

/** Pending to confirmed once the money is captured. Anything else is refused. */
export function confirmOrder(order: OrderState, now: Temporal.Instant): OrderState | null {
  if (order.status !== 'pending-payment') return null;
  return {
    ...order,
    status: 'confirmed',
    paymentState: 'captured',
    confirmedAt: now,
  };
}

/**
 * Pending to cancelled. A confirmed or already cancelled order is not touched. An order whose
 * payment is authorised (a confirm is in progress) is cancelled only by a caller that has just
 * voided that authorisation and says so with `paymentState` `voided`.
 */
export function cancelOrder(
  order: OrderState,
  reason: CancelReason,
  paymentState: PaymentState,
  now: Temporal.Instant,
): OrderState | null {
  if (order.status !== 'pending-payment') return null;
  if (order.paymentState === 'authorised' && paymentState !== 'voided') return null;
  return { ...order, status: 'cancelled', cancelReason: reason, paymentState, cancelledAt: now };
}

/** The carrier and tracking reference the seller typed in, already checked. */
export interface ShipmentInput {
  readonly carrier: string;
  readonly trackingRef: string | null;
}

/** `to-ship` to `shipped`. Anything else is refused (null): a shipment is recorded once. */
export function markShipped(
  sellerOrder: SellerOrder,
  shipment: ShipmentInput,
  now: Temporal.Instant,
): SellerOrder | null {
  if (sellerOrder.fulfilment !== 'to-ship') return null;
  return {
    ...sellerOrder,
    fulfilment: 'shipped',
    carrier: shipment.carrier,
    trackingRef: shipment.trackingRef,
    shippedAt: now,
  };
}

/** `shipped` to `delivered`. A seller order that was never shipped cannot be delivered. */
export function markDelivered(sellerOrder: SellerOrder, now: Temporal.Instant): SellerOrder | null {
  if (sellerOrder.fulfilment !== 'shipped') return null;
  return { ...sellerOrder, fulfilment: 'delivered', deliveredAt: now };
}

const CARRIER = /^[\p{L}\p{N}][\p{L}\p{N} .,&'()/+-]{0,58}[\p{L}\p{N}.)]$|^[\p{L}\p{N}]$/u;
const TRACKING = /^[A-Za-z0-9][A-Za-z0-9 ._/#-]{0,78}[A-Za-z0-9]$|^[A-Za-z0-9]$/;

/**
 * The seller's own words for a shipment, checked: a carrier name of 1 to 60 characters (letters,
 * digits and a few marks) and an optional tracking reference of 1 to 80. No markup or link can
 * pass, so the customer's page can show both as plain text.
 */
export function parseShipment(input: {
  readonly carrier: unknown;
  readonly trackingRef: unknown;
}):
  | { readonly ok: true; readonly shipment: ShipmentInput }
  | { readonly ok: false; readonly fields: readonly { path: string; code: string }[] } {
  const fields: { path: string; code: string }[] = [];
  const carrier = typeof input?.carrier === 'string' ? input.carrier.normalize('NFC').trim() : '';
  if (!CARRIER.test(carrier)) fields.push({ path: 'carrier', code: 'format' });
  let trackingRef: string | null = null;
  if (input?.trackingRef !== undefined && input.trackingRef !== null && input.trackingRef !== '') {
    const text = typeof input.trackingRef === 'string' ? input.trackingRef.trim() : '';
    if (TRACKING.test(text)) trackingRef = text;
    else fields.push({ path: 'trackingRef', code: 'format' });
  }
  return fields.length > 0
    ? { ok: false, fields }
    : { ok: true, shipment: { carrier, trackingRef } };
}
