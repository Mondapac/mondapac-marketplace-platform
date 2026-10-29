import type { Id, MarketId, Money, Temporal } from '@mondapac/shared-kernel';
import type { DeliveryAttention, DeliveryMethod, DeliveryWindow } from './delivery-method';

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
  /**
   * The commission rate in basis points, frozen at placement (COM-04): a later change of the
   * seller's or the Market's rate never touches this order. Null only on lines placed before the
   * rate was frozen.
   */
  readonly commissionRateBps: number | null;
  /**
   * The tax rate and the tax of the line, frozen at placement from `tax` (ADR-0039 decision 4).
   * Both null only on lines placed before tax was recorded. The tax is part of `lineAmount` when
   * the price includes tax, and added on top of it otherwise.
   */
  readonly taxRateBps: number | null;
  readonly taxAmount: bigint | null;
  /**
   * The tax category code of the product, frozen with the rate at placement (catalog's published
   * revision). Null only on lines placed before it was recorded.
   */
  readonly taxCategoryCode: string | null;
}

/**
 * Whether the worker has written a paid seller order into the seller ledger (commission-payouts):
 * `pending` until it has, then `recorded`. Seller orders placed before the commission rate was
 * frozen on their lines are `not-applicable` and never reach the ledger.
 */
export type LedgerState = 'pending' | 'recorded' | 'not-applicable';

/** Where a seller order stands once it is paid: `to-ship`, then `shipped`, then `delivered`. */
export type Fulfilment = 'to-ship' | 'shipped' | 'delivered';

/**
 * The part of an order that belongs to one seller. `shipping` is the seller's flat fee as it was
 * when the order was placed (SHP-01), part of `total`, as is the tax of any line whose price
 * excludes tax (added on top of the goods). The seller records the shipment (carrier
 * and an optional tracking reference) and then the delivery, each once and in that order.
 */
/**
 * The delivery quote charged for a seller order, frozen at placement (delivery models, package
 * 5): shipping's quote id, the fleet quoted, the fleet's price, the platform's margin and the
 * instants it was asked and stopped holding. `shipping` is the buyer's price: price + margin. A
 * pickup, and an order placed before quotes were kept, have none.
 */
export interface ChargedDeliveryQuote {
  readonly quoteId: string;
  readonly fleet: string;
  readonly quoteAmount: bigint;
  readonly marginAmount: bigint;
  readonly quotedAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
}

export interface SellerOrder {
  readonly id: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly subtotal: bigint;
  readonly shipping: bigint;
  /**
   * The tax on the shipping fee, frozen at placement with its rate and price basis. All three
   * are null on seller orders placed before it was recorded (unknown, never zero).
   */
  readonly shippingTaxRateBps: number | null;
  readonly shippingTax: bigint | null;
  readonly shippingTaxInclusive: boolean | null;
  readonly total: bigint;
  readonly fulfilment: Fulfilment;
  readonly carrier: string | null;
  readonly trackingRef: string | null;
  readonly shippedAt: Temporal.Instant | null;
  readonly deliveredAt: Temporal.Instant | null;
  /** When inventory was told the lines left the warehouse; null until the worker did it. */
  readonly inventoryRecordedAt: Temporal.Instant | null;
  readonly ledgerState: LedgerState;
  /** The buyer's delivery method, chosen at checkout; the seller cannot change it. */
  readonly deliveryMethod: DeliveryMethod;
  /** The buyer's window for a `scheduled` delivery (UTC instants); null for every other method. */
  readonly deliveryWindow: DeliveryWindow | null;
  /** When the seller told the platform the order is ready; null until then. */
  readonly readyAt: Temporal.Instant | null;
  /**
   * Set by the platform when no carrier could take the order: it needs the platform's attention.
   * The seller is never asked to deliver instead.
   */
  readonly deliveryAttention: DeliveryAttention | null;
  /** The quote the buyer was charged for delivery; null for a pickup and for older orders. */
  readonly deliveryQuote: ChargedDeliveryQuote | null;
}

/**
 * Where the order goes (customers package 2): a fixed copy of the address the customer picked at
 * checkout, so a later change or removal in the address book never touches a placed order.
 * PERSONAL DATA: never logged, never in an event or an error.
 */
export interface ShipTo {
  readonly recipientFirstName: string;
  readonly recipientLastName: string;
  readonly phone: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly suburb: string;
  readonly region: string | null;
  readonly postcode: string;
  readonly deliveryNotes: string | null;
  /** ISO 3166 country of the address. */
  readonly countryCode: string;
  /**
   * The customer's note to each seller of the order (plain text, 1 to 200 characters), keyed by
   * seller id; absent when none was written. Sealed with the address, so erasure removes it too;
   * a seller reads only its own.
   */
  readonly sellerNotes?: Readonly<Record<string, string>>;
}

/** The longest note a customer may leave for one seller, in characters. */
export const SELLER_NOTE_MAX = 200;
/** No order has more seller orders than this; a larger notes object is refused whole. */
const SELLER_NOTES_MAX = 50;

/**
 * Parses the `sellerNotes` of a checkout: absent, or an object of seller id to text. Each note is
 * trimmed (CRLF becomes LF); an empty one is dropped; one over {@link SELLER_NOTE_MAX} characters,
 * or with a control or invisible format character other than a line break, is refused. Ids are checked by the caller against the order's sellers.
 */
export function parseSellerNotes(
  value: unknown,
): { ok: true; notes: ReadonlyMap<string, string> } | { ok: false; path: string; code: string } {
  if (value === undefined || value === null) return { ok: true, notes: new Map() };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, path: 'sellerNotes', code: 'type' };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > SELLER_NOTES_MAX) return { ok: false, path: 'sellerNotes', code: 'range' };
  const notes = new Map<string, string>();
  for (const [sellerId, raw] of entries) {
    // The path never echoes a key that is not an id.
    const path = /^[0-9a-f-]{36}$/u.test(sellerId) ? `sellerNotes.${sellerId}` : 'sellerNotes';
    if (path === 'sellerNotes') return { ok: false, path, code: 'format' };
    if (typeof raw !== 'string') return { ok: false, path, code: 'type' };
    const note = raw.replace(/\r\n/gu, '\n').trim();
    // Line breaks are the only control allowed. Invisible format characters (bidi overrides,
    // zero-width spaces) and the Unicode line and paragraph separators are refused, so a note
    // reads on the seller's page as it was written; the zero-width joiner stays for emoji.
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(note.replace(/[\n\u200d]/gu, ''))) {
      return { ok: false, path, code: 'format' };
    }
    if ([...note].length > SELLER_NOTE_MAX) return { ok: false, path, code: 'length' };
    if (note !== '') notes.set(sellerId, note);
  }
  return { ok: true, notes };
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
  /**
   * The tax strategy the order's tax was worked out under: its id, or null for the Market's
   * built-in one (and on orders placed before tax was recorded).
   */
  readonly taxStrategyId: Id<'TaxStrategy'> | null;
  /**
   * The {@link ShipTo} sealed under the customer account's subject key, written once at
   * checkout; null on orders placed before the address was recorded. Erasing the account makes it
   * unreadable for ever while the order's financial record stays.
   */
  readonly shipToSealed: string | null;
  readonly sellerOrders: readonly SellerOrder[];
  readonly lines: readonly OrderLine[];
}

/**
 * What a seller order's shipping tax adds to the order tax: the recorded tax, or nothing for a
 * seller order placed before it was recorded.
 */
export function shippingTaxOf(seller: SellerOrder): bigint {
  return seller.shippingTax ?? 0n;
}

/**
 * The tax of some order lines: the sum of their frozen tax, or null when any of them was placed
 * before tax was recorded (an unknown tax is never shown as zero).
 */
export function linesTax(lines: readonly OrderLine[]): bigint | null {
  let sum = 0n;
  for (const line of lines) {
    if (line.taxAmount === null) return null;
    sum += line.taxAmount;
  }
  return sum;
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

/**
 * The seller tells the platform the order is ready (packed, waiting). Only a paid order still
 * `to-ship` that is not ready yet can become ready; anything else is null. The seller picks no
 * method and no provider here: the buyer's method and the fleet decide.
 */
export function markReady(sellerOrder: SellerOrder, now: Temporal.Instant): SellerOrder | null {
  if (sellerOrder.fulfilment !== 'to-ship' || sellerOrder.readyAt !== null) return null;
  return { ...sellerOrder, readyAt: now };
}

/** Records that no carrier could take the order (once; null when already recorded or shipped). */
export function markNeedsAttention(
  sellerOrder: SellerOrder,
  reason: DeliveryAttention,
): SellerOrder | null {
  if (sellerOrder.fulfilment !== 'to-ship' || sellerOrder.deliveryAttention === reason) return null;
  return { ...sellerOrder, deliveryAttention: reason };
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

/**
 * A pickup order the seller marked ready is handed over: `to-ship` to `delivered` in one step,
 * because no carrier is ever involved (no carrier name, no tracking reference). The pickup time
 * is both the shipped and the delivered time. Anything else is refused (null): another method,
 * an order not ready yet, or one that has already moved on.
 */
export function markCollected(sellerOrder: SellerOrder, now: Temporal.Instant): SellerOrder | null {
  if (
    sellerOrder.deliveryMethod !== 'pickup' ||
    sellerOrder.fulfilment !== 'to-ship' ||
    sellerOrder.readyAt === null
  ) {
    return null;
  }
  return { ...sellerOrder, fulfilment: 'delivered', shippedAt: now, deliveredAt: now };
}

const CARRIER = /^[\p{L}\p{N}][\p{L}\p{N} .,&'()+-]{0,58}[\p{L}\p{N}.)]$|^[\p{L}\p{N}]$/u;
/** A dot followed by two letters reads as a domain name, which a mail client may turn into a link. */
const LINK_LIKE = /\.\p{L}{2}/u;
const TRACKING = /^[A-Za-z0-9][A-Za-z0-9 ._#-]{0,78}[A-Za-z0-9]$|^[A-Za-z0-9]$/;

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
  if (!CARRIER.test(carrier) || LINK_LIKE.test(carrier))
    fields.push({ path: 'carrier', code: 'format' });
  let trackingRef: string | null = null;
  if (input?.trackingRef !== undefined && input.trackingRef !== null && input.trackingRef !== '') {
    const text = typeof input.trackingRef === 'string' ? input.trackingRef.trim() : '';
    if (TRACKING.test(text) && !LINK_LIKE.test(text)) trackingRef = text;
    else fields.push({ path: 'trackingRef', code: 'format' });
  }
  return fields.length > 0
    ? { ok: false, fields }
    : { ok: true, shipment: { carrier, trackingRef } };
}
