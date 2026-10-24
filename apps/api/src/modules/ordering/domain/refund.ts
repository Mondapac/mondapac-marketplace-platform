import { parseId } from '@mondapac/shared-kernel';
import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { OrderStatus, PaymentState } from './order';

// Refunds of a paid seller order by an admin (tax step 3; ADR-0007 decision 11; no seller path,
// ordering design 97): whole lines, some units of a
// line, or part or all of the flat shipping fee. Every amount comes from the values frozen on the
// order (unit price, line tax, shipping tax); the tax reversed comes from `tax`, never from a
// current price or rate. A refund never gives back more than the seller order took.

/** Hadi's list (ordering data design O6a). */
export const REFUND_REASONS = [
  'not-received',
  'damaged',
  'wrong-item',
  'not-as-described',
  'seller-cancelled',
  'other',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
/** `pending` until Stripe answers; then `succeeded` (with a credit note) or `failed`. */
export type RefundState = 'pending' | 'succeeded' | 'failed';

export interface RefundLine {
  readonly orderLineId: Id<'OrderLine'>;
  readonly quantity: number;
  /** The order line's own quantity: the database refuses units past it. */
  readonly lineQuantity: number;
  /** Units of the line refunded by earlier refunds that had not failed. */
  readonly unitsBefore: number;
  readonly gross: bigint;
  readonly tax: bigint;
  readonly taxRateBps: number;
  readonly taxInclusive: boolean;
}

export interface Refund {
  readonly id: Id<'Refund'>;
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly currency: string;
  /** Lines plus shipping, tax included: what goes back to the customer. */
  readonly gross: bigint;
  readonly tax: bigint;
  /** The shipping part (gross and its tax), with the seller order's frozen rate and basis. */
  readonly shipping: {
    readonly gross: bigint;
    readonly tax: bigint;
    readonly taxRateBps: number;
    readonly taxInclusive: boolean;
  } | null;
  readonly reason: RefundReason;
  readonly actor: { readonly population: 'admin'; readonly accountId: Id<'Account'> };
  readonly state: RefundState;
  readonly stripeIdempotencyKey: string;
  readonly stripeRefundId: string | null;
  readonly attempts: number;
  readonly requestedAt: Temporal.Instant;
  readonly settledAt: Temporal.Instant | null;
  readonly lines: readonly RefundLine[];
}

/** One order line as a refund needs it: its frozen price, quantity and tax. */
export interface RefundableLine {
  readonly id: Id<'OrderLine'>;
  readonly quantity: number;
  readonly unitAmount: bigint;
  readonly taxInclusive: boolean;
  readonly taxRateBps: number | null;
  readonly taxAmount: bigint | null;
}

/** A seller order with what earlier refunds (not failed) have already given back. */
export interface RefundTarget {
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly currency: string;
  readonly orderStatus: OrderStatus;
  readonly paymentState: PaymentState;
  readonly paymentIntentId: string | null;
  readonly shipping: bigint;
  readonly shippingTax: bigint | null;
  readonly shippingTaxRateBps: number | null;
  readonly shippingTaxInclusive: boolean | null;
  readonly total: bigint;
  /** The gross of the refunds not failed (the stored running sum). */
  readonly refunded: bigint;
  /** Whether a refund of this seller order is still waiting for Stripe. */
  readonly pending: boolean;
  readonly lines: readonly RefundableLine[];
  /** Units already refunded per line, and the shipping gross already refunded. */
  readonly refundedUnits: ReadonlyMap<Id<'OrderLine'>, number>;
  /** Units per line of the refunds Stripe confirmed (a subset of `refundedUnits`). */
  readonly succeededUnits: ReadonlyMap<Id<'OrderLine'>, number>;
  readonly refundedShipping: bigint;
}

export interface RefundRequest {
  readonly lines: readonly { readonly orderLineId: Id<'OrderLine'>; readonly quantity: number }[];
  /** The shipping gross to give back, in minor units; 0 for none. */
  readonly shipping: bigint;
  readonly reason: RefundReason;
}

export type RefundRefusal =
  /** The order was never paid or the money was not captured. */
  | { readonly code: 'ordering.refund-not-allowed' }
  /** A refund of this seller order is still waiting for Stripe. */
  | { readonly code: 'ordering.refund-in-progress' }
  /** A line or the shipping fee was placed before its tax was recorded: nothing is guessed. */
  | { readonly code: 'ordering.refund-tax-unknown' }
  /** More than is left to refund: a line, its units or the shipping fee (fields name which). */
  | {
      readonly code: 'ordering.refund-exceeds';
      readonly fields: readonly { path: string; code: string }[];
    };

/** What `tax` is asked to reverse, in the order of the request's lines (then the shipping). */
export interface RefundPlan {
  readonly lines: readonly {
    readonly line: RefundableLine;
    readonly unitsBefore: number;
    readonly units: number;
  }[];
  readonly shipping: {
    readonly gross: bigint;
    readonly tax: bigint;
    readonly before: bigint;
    readonly after: bigint;
  } | null;
}

const MAX_LINES = 200;
const MAX_AMOUNT = 2n ** 53n - 1n;

/** The request body, checked: lines (no line twice), an optional shipping amount and a reason. */
export function parseRefundRequest(input: {
  readonly lines: unknown;
  readonly shippingAmount: unknown;
  readonly reason: unknown;
}):
  | { readonly ok: true; readonly request: RefundRequest }
  | { readonly ok: false; readonly fields: readonly { path: string; code: string }[] } {
  const fields: { path: string; code: string }[] = [];
  const lines: { orderLineId: Id<'OrderLine'>; quantity: number }[] = [];
  const raw = input?.lines ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_LINES) {
    fields.push({ path: 'lines', code: 'range' });
  } else {
    raw.forEach((line: Record<string, unknown> | null, index) => {
      const parsed =
        typeof line?.orderLineId === 'string' ? parseId<'OrderLine'>(line.orderLineId) : null;
      const quantity = line?.quantity;
      if (parsed === null || !parsed.ok) {
        fields.push({ path: `lines.${index}.orderLineId`, code: 'format' });
      } else if (lines.some((l) => l.orderLineId === parsed.value)) {
        fields.push({ path: `lines.${index}.orderLineId`, code: 'duplicate' });
      }
      if (
        typeof quantity !== 'number' ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 999
      ) {
        fields.push({ path: `lines.${index}.quantity`, code: 'range' });
      }
      if (parsed !== null && parsed.ok && typeof quantity === 'number') {
        lines.push({ orderLineId: parsed.value, quantity });
      }
    });
  }
  let shipping = 0n;
  const amount = input?.shippingAmount;
  if (amount !== undefined && amount !== null) {
    if (
      typeof amount === 'string' &&
      /^[0-9]{1,16}$/.test(amount) &&
      BigInt(amount) <= MAX_AMOUNT
    ) {
      shipping = BigInt(amount);
    } else fields.push({ path: 'shippingAmount', code: 'format' });
  }
  const reason = input?.reason;
  if (!REFUND_REASONS.includes(reason as RefundReason))
    fields.push({ path: 'reason', code: 'value' });
  if (fields.length === 0 && lines.length === 0 && shipping === 0n) {
    fields.push({ path: 'lines', code: 'required' });
  }
  return fields.length > 0
    ? { ok: false, fields }
    : { ok: true, request: { lines, shipping, reason: reason as RefundReason } };
}

/** The shipping fee as the customer paid it: the fee plus its tax when the fee excluded tax. */
export function shippingGross(target: RefundTarget): bigint | null {
  if (target.shippingTax === null || target.shippingTaxInclusive === null) return null;
  return target.shipping + (target.shippingTaxInclusive ? 0n : target.shippingTax);
}

/**
 * Checks a request against what the seller order took and what earlier refunds gave back, and
 * says which units and which part of the shipping fee `tax` must reverse. Fails closed: a line or
 * a fee without frozen tax is never refunded on a guess.
 */
export function planRefund(
  target: RefundTarget,
  request: RefundRequest,
):
  | { readonly ok: true; readonly plan: RefundPlan }
  | { readonly ok: false; readonly error: RefundRefusal } {
  if (
    target.orderStatus !== 'confirmed' ||
    target.paymentState !== 'captured' ||
    target.paymentIntentId === null
  ) {
    return { ok: false, error: { code: 'ordering.refund-not-allowed' } };
  }
  if (target.pending) return { ok: false, error: { code: 'ordering.refund-in-progress' } };
  const fields: { path: string; code: string }[] = [];
  const lines: RefundPlan['lines'][number][] = [];
  let unknownTax = false;
  request.lines.forEach((wanted, index) => {
    const line = target.lines.find((l) => l.id === wanted.orderLineId);
    if (line === undefined) {
      fields.push({ path: `lines.${index}.orderLineId`, code: 'not-found' });
      return;
    }
    if (line.taxAmount === null || line.taxRateBps === null) unknownTax = true;
    const unitsBefore = target.refundedUnits.get(line.id) ?? 0;
    if (unitsBefore + wanted.quantity > line.quantity) {
      fields.push({ path: `lines.${index}.quantity`, code: 'exceeds' });
      return;
    }
    lines.push({ line, unitsBefore, units: wanted.quantity });
  });
  let shipping: RefundPlan['shipping'] = null;
  if (request.shipping > 0n) {
    const gross = shippingGross(target);
    if (gross === null) unknownTax = true;
    else if (target.refundedShipping + request.shipping > gross) {
      fields.push({ path: 'shippingAmount', code: 'exceeds' });
    } else {
      shipping = {
        gross,
        tax: target.shippingTax!,
        before: target.refundedShipping,
        after: target.refundedShipping + request.shipping,
      };
    }
  }
  if (unknownTax) return { ok: false, error: { code: 'ordering.refund-tax-unknown' } };
  if (fields.length > 0) return { ok: false, error: { code: 'ordering.refund-exceeds', fields } };
  return { ok: true, plan: { lines, shipping } };
}

/**
 * The refund's money from the plan and the tax `tax` reversed (one per line, then the shipping):
 * a tax-inclusive line gives back its unit price per unit (the tax is inside), a tax-exclusive
 * line its unit price plus the tax reversed. Null when the sum would pass what the seller order
 * took (it cannot from a valid plan; checked again, fail closed).
 */
export function priceRefund(
  target: RefundTarget,
  plan: RefundPlan,
  reversed: { readonly lines: readonly bigint[]; readonly charges: readonly bigint[] },
  details: Pick<Refund, 'id' | 'reason' | 'actor' | 'stripeIdempotencyKey' | 'requestedAt'>,
): Refund | null {
  const lines: RefundLine[] = plan.lines.map(({ line, unitsBefore, units }, index) => {
    const tax = reversed.lines[index]!;
    const goods = line.unitAmount * BigInt(units);
    return {
      orderLineId: line.id,
      quantity: units,
      lineQuantity: line.quantity,
      unitsBefore,
      gross: line.taxInclusive ? goods : goods + tax,
      tax,
      taxRateBps: line.taxRateBps!,
      taxInclusive: line.taxInclusive,
    };
  });
  const shipping =
    plan.shipping === null
      ? null
      : {
          gross: plan.shipping.after - plan.shipping.before,
          tax: reversed.charges[0]!,
          taxRateBps: target.shippingTaxRateBps!,
          taxInclusive: target.shippingTaxInclusive!,
        };
  const gross = lines.reduce((sum, l) => sum + l.gross, 0n) + (shipping?.gross ?? 0n);
  const tax = lines.reduce((sum, l) => sum + l.tax, 0n) + (shipping?.tax ?? 0n);
  if (gross <= 0n || target.refunded + gross > target.total) return null;
  return {
    ...details,
    orderId: target.orderId,
    sellerOrderId: target.sellerOrderId,
    sellerId: target.sellerId,
    currency: target.currency,
    gross,
    tax,
    shipping,
    state: 'pending',
    stripeRefundId: null,
    attempts: 0,
    settledAt: null,
    lines,
  };
}

/**
 * Whether every unit of the seller order is refunded (SHP-03): by the refunds Stripe confirmed
 * (`succeeded`, before a carrier delivery is cancelled), or by every refund not failed
 * (`not-failed`, before one is booked: money on its way back is never delivered).
 */
export function refundedInFull(target: RefundTarget, by: 'succeeded' | 'not-failed'): boolean {
  const units = by === 'succeeded' ? target.succeededUnits : target.refundedUnits;
  return target.lines.every((line) => (units.get(line.id) ?? 0) >= line.quantity);
}
