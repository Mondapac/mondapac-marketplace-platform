import { unitKey } from '../cart/live-cart.ts';
import type {
  AccountOrder,
  Money,
  OrderLine,
  OrderPart,
  OrderPartStatus,
} from '../storefront/types.ts';

// The buyer's real orders (`GET /orders`, `GET /orders/:orderId`) as the account pages show them.
// Only orders that were paid are shown: an order still waiting for payment, or one whose payment
// never went through, is not one the buyer placed. Every field is checked on its own; an order the
// pages cannot show is left out, the rest of the list stays. Pure, for the server pages and tests.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CURRENCY = /^[A-Z]{3}$/u;
const DIGITS = /^[0-9]{1,15}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T/u;

type Json = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown, max = 300): string | null =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max ? value.trim() : null;

/** Whether a string is an order id (the API's UUID), the key of an order's page. */
export const isOrderId = (value: string): boolean => UUID.test(value);

/** The reference the buyer sees: the order id's first eight characters, upper case. */
export const orderReference = (orderId: string): string => orderId.slice(0, 8).toUpperCase();

function moneyOf(value: unknown): Money | null {
  if (!isRecord(value)) return null;
  const { amount, currency } = value;
  if (typeof amount !== 'string' || !DIGITS.test(amount)) return null;
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) return null;
  const minor = Number(amount);
  return Number.isSafeInteger(minor) ? { amount: minor, currency } : null;
}

/** The ISO date (UTC) of an instant, or null. */
const dayOf = (value: unknown): string | null =>
  typeof value === 'string' && INSTANT.test(value) ? value.slice(0, 10) : null;

function partStatus(cancelled: boolean, fulfilment: unknown): OrderPartStatus | null {
  if (cancelled) return 'cancelled';
  if (fulfilment === 'delivered') return 'delivered';
  if (fulfilment === 'shipped') return 'out-for-delivery';
  // Paid and not shipped yet: the seller has the order (there is no separate accept step).
  return fulfilment === 'to-ship' ? 'confirmed' : null;
}

function lineOf(value: unknown, unnamed: string): OrderLine | null {
  if (!isRecord(value)) return null;
  const offerId =
    typeof value.offerId === 'string' && UUID.test(value.offerId) ? value.offerId : null;
  const variantId =
    typeof value.variantId === 'string' && UUID.test(value.variantId) ? value.variantId : null;
  const quantity = value.quantity;
  const unitPrice = moneyOf(value.unitPrice);
  if (offerId === null || variantId === null || unitPrice === null) return null;
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1) return null;
  const name = text(value.productName);
  const label = text(value.variantLabel, 100);
  return {
    // The sell unit's cart key, so Buy again adds the same unit.
    offerId: unitKey({ offerId: offerId.toLowerCase(), variantId: variantId.toLowerCase() }),
    name: name === null ? unnamed : label === null ? name : `${name}, ${label}`,
    category: '',
    quantity,
    unitPrice,
  };
}

/** What the account shows of one order body; null when it is not a paid order it can show. */
export function accountOrderOf(
  body: unknown,
  labels: { readonly unnamedItem: string; readonly unnamedSeller: string },
  deliveredTo = '',
): AccountOrder | null {
  if (!isRecord(body)) return null;
  const orderId = typeof body.orderId === 'string' && UUID.test(body.orderId) ? body.orderId : null;
  const placedOn = dayOf(body.confirmedAt);
  // Never paid (still waiting, expired, payment failed): not an order the buyer placed.
  if (orderId === null || placedOn === null || !Array.isArray(body.sellerOrders)) return null;
  if (body.status !== 'confirmed' && body.status !== 'cancelled') return null;
  const cancelled = body.status === 'cancelled';
  const notes = isRecord(body.sellerNotes) ? body.sellerNotes : {};
  const parts: OrderPart[] = [];
  for (const seller of body.sellerOrders) {
    if (!isRecord(seller) || !Array.isArray(seller.lines)) return null;
    const sellerId = typeof seller.sellerId === 'string' ? seller.sellerId : null;
    const status = partStatus(cancelled, seller.fulfilment);
    const deliveryFee = moneyOf(seller.shipping);
    const lines = seller.lines.map((line) => lineOf(line, labels.unnamedItem));
    if (sellerId === null || status === null || deliveryFee === null) return null;
    if (lines.length === 0 || lines.some((line) => line === null)) return null;
    const deliveredOn = status === 'delivered' ? dayOf(seller.deliveredAt) : null;
    const note = text(notes[sellerId], 200);
    parts.push({
      sellerId,
      sellerName: text(seller.storeName) ?? labels.unnamedSeller,
      status,
      // No delivery promise in the backend yet: the page shows the day it was delivered, if any.
      deliveryWindow: '',
      ...(deliveredOn === null ? {} : { deliveredOn }),
      deliveryFee,
      ...(note === null ? {} : { note }),
      lines: lines as OrderLine[],
    });
  }
  const [first, ...rest] = parts;
  if (first === undefined) return null;
  const allDelivered = parts.every((part) => part.status === 'delivered');
  const tax = moneyOf(body.tax);
  return {
    id: orderId.toLowerCase(),
    reference: orderReference(orderId),
    placedOn,
    status: cancelled ? 'cancelled' : allDelivered ? 'delivered' : 'in-progress',
    deliveredTo,
    parts: [first, ...rest],
    includedTax: tax ?? { amount: 0, currency: first.deliveryFee.currency },
    ...(tax === null ? { taxKnown: false } : {}),
  };
}

/** The account's orders of a `GET /orders` page, newest first; null when it is not one. */
export function accountOrdersOf(
  body: unknown,
  labels: { readonly unnamedItem: string; readonly unnamedSeller: string },
): AccountOrder[] | null {
  if (!isRecord(body) || !Array.isArray(body.orders)) return null;
  return body.orders.flatMap((order) => {
    const shown = accountOrderOf(order, labels);
    return shown === null ? [] : [shown];
  });
}

/** The delivery address of an order body (`shipTo`), as one line; empty when there is none. */
export function shipToLine(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.shipTo)) return '';
  const to = body.shipTo;
  const first = text(to.recipientFirstName);
  const last = text(to.recipientLastName);
  const line1 = text(to.line1);
  const suburb = text(to.suburb);
  const postcode = text(to.postcode, 16);
  if (first === null || last === null || line1 === null || suburb === null || postcode === null)
    return '';
  const line2 = text(to.line2);
  const region = text(to.region, 40);
  const street = line2 === null ? line1 : `${line1}, ${line2}`;
  return `${first} ${last}: ${street}, ${suburb}${region === null ? '' : ` ${region}`} ${postcode}`;
}
