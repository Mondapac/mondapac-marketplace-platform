'use server';

import { checkDeliveryArea, sampleDeliveryOptionsFor, takePayment } from '../storefront/source.ts';
import type {
  DeliveryAreaAnswer,
  DeliveryOptionsAnswer,
  Money,
  PayAnswer,
  PayRequest,
  QuoteAddress,
} from '../storefront/types.ts';

// The checkout's server actions: the storefront's BFF side of checkout. Next.js refuses a server
// action whose Origin is not this host. The postcode a buyer types is never logged.

/** Whether the Market delivers to a new address's postcode. */
export async function deliveryAreaFor(raw: unknown): Promise<DeliveryAreaAnswer> {
  if (typeof raw !== 'string') return { kind: 'failed' };
  return checkDeliveryArea(raw);
}

/** The most sellers one checkout asks quotes for (a cart holds far fewer). */
const MAX_SELLERS = 50;
const ID = /^[A-Za-z0-9_-]{1,64}$/u;
/** A postcode in any market's style: letters, digits, spaces and hyphens (AU 4031, UK SW1A 1AA). */
const POSTCODE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/u;

/** A quote request as the browser sent it, or null when it is not one. */
function quoteRequest(
  raw: unknown,
): { readonly address: QuoteAddress; readonly sellerIds: readonly string[] } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { address, sellerIds } = raw as { address?: unknown; sellerIds?: unknown };
  if (
    !Array.isArray(sellerIds) ||
    sellerIds.length === 0 ||
    sellerIds.length > MAX_SELLERS ||
    !sellerIds.every((id) => typeof id === 'string' && ID.test(id)) ||
    new Set(sellerIds).size !== sellerIds.length
  )
    return null;
  const where = quoteAddress(address);
  return where === null ? null : { address: where, sellerIds: sellerIds as string[] };
}

function quoteAddress(address: unknown): QuoteAddress | null {
  if (typeof address !== 'object' || address === null) return null;
  const { kind, id, postcode } = address as { kind?: unknown; id?: unknown; postcode?: unknown };
  if (kind === 'saved' && typeof id === 'string' && ID.test(id)) return { kind, id };
  if (kind === 'new' && typeof postcode === 'string' && POSTCODE.test(postcode.trim()))
    return { kind, postcode: postcode.trim() };
  return null;
}

/**
 * The sample delivery options of the sellers, while the buyer's session is not live (with the API
 * configured the browser asks `orders/delivery-quotes` through the session relay instead). A
 * malformed request or a failure answers `failed` (the page offers Try again).
 */
export async function deliveryOptionsFor(raw: unknown): Promise<DeliveryOptionsAnswer> {
  const request = quoteRequest(raw);
  if (request === null) return { kind: 'failed' };
  try {
    return await sampleDeliveryOptionsFor(request.address, request.sellerIds);
  } catch {
    return { kind: 'failed' };
  }
}

/** The most lines one order holds, and the most of one line (the cart's own limit is 12). */
const MAX_LINES = 100;
const MAX_QUANTITY = 99;
const TOKEN = /^ctoken_[A-Za-z0-9_]{1,200}$/u;
const CODE = /^[A-Za-z0-9-]{1,32}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

function money(raw: unknown): Money | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { amount, currency } = raw as { amount?: unknown; currency?: unknown };
  return Number.isSafeInteger(amount) &&
    (amount as number) >= 0 &&
    typeof currency === 'string' &&
    CURRENCY.test(currency)
    ? { amount: amount as number, currency }
    : null;
}

/**
 * Own keys of a plain record of up to `max` ids, or null. A key that names a property every object
 * has (`__proto__`, `constructor`, `toString`) is refused: looked up by id it would be found.
 */
function idsOf(raw: unknown, max: number): string[] | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const ids = Object.keys(raw);
  return ids.length > 0 &&
    ids.length <= max &&
    ids.every((id) => ID.test(id) && !(id in Object.prototype))
    ? ids
    : null;
}

/** A Pay request as the browser sent it, or null when it is not one. */
function payRequest(raw: unknown): PayRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const method = r.method;
  if (method !== 'card' && method !== 'stripe') return null;
  const token = r.confirmationToken;
  if (token !== null && !(method === 'card' && typeof token === 'string' && TOKEN.test(token)))
    return null;
  const address = quoteAddress(r.address);
  const total = money(r.total);
  const code = r.discountCode;
  if (address === null || total === null) return null;
  if (code !== null && !(typeof code === 'string' && CODE.test(code))) return null;
  const lineIds = idsOf(r.lines, MAX_LINES);
  const sellerIds = idsOf(r.delivery, MAX_SELLERS);
  if (lineIds === null || sellerIds === null) return null;
  const lines: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const id of lineIds) {
    const quantity = (r.lines as Record<string, unknown>)[id];
    if (
      !Number.isSafeInteger(quantity) ||
      (quantity as number) < 1 ||
      (quantity as number) > MAX_QUANTITY
    )
      return null;
    lines[id] = quantity as number;
  }
  const delivery = Object.create(null) as Record<string, PayRequest['delivery'][string]>;
  for (const id of sellerIds) {
    const choice = (r.delivery as Record<string, unknown>)[id];
    if (typeof choice !== 'object' || choice === null) return null;
    const { method: how, quoteId, window, total: seen } = choice as Record<string, unknown>;
    if (how !== 'pickup' && how !== 'instant' && how !== 'same_day' && how !== 'scheduled')
      return null;
    const paid = money(seen);
    if (paid === null || paid.currency !== total.currency) return null;
    if (how === 'pickup') {
      if (quoteId !== null) return null;
    } else if (typeof quoteId !== 'string' || !ID.test(quoteId)) return null;
    let when: { readonly start: string; readonly end: string } | null = null;
    if (how === 'scheduled') {
      if (typeof window !== 'object' || window === null) return null;
      const { start, end } = window as { start?: unknown; end?: unknown };
      if (typeof start !== 'string' || typeof end !== 'string') return null;
      if (!INSTANT.test(start) || !INSTANT.test(end)) return null;
      when = { start, end };
    } else if (window !== null) return null;
    delivery[id] = { method: how, quoteId, window: when, total: paid };
  }
  return {
    method,
    confirmationToken: token,
    address,
    lines,
    delivery,
    discountCode: code,
    total,
  };
}

/**
 * Pay: the server checks the order again and takes the payment, or says what changed. The browser
 * sends the order as the buyer saw it and, for the card tile, Stripe's confirmation token: card
 * numbers go to Stripe only. A malformed request or a failure answers `failed` (nothing charged).
 */
export async function payOrder(raw: unknown): Promise<PayAnswer> {
  const request = payRequest(raw);
  if (request === null) return { kind: 'failed' };
  try {
    return await takePayment(request);
  } catch (error) {
    // No token, address or card detail in the log: the method and the error's kind only.
    console.log(
      JSON.stringify({
        msg: 'storefront.pay-failed',
        method: request.method,
        error: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return { kind: 'failed' };
  }
}
