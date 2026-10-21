'use server';

import { checkDeliveryArea, quoteDelivery, takePayment } from '../storefront/source.ts';
import type {
  DeliveryAreaAnswer,
  DeliveryQuote,
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
 * Each seller's delivery quote for the chosen address. A malformed request answers nothing and a
 * failure answers `failed`; the page shows a seller without an answer as failed (Try again).
 */
export async function deliveryQuotesFor(
  raw: unknown,
): Promise<Readonly<Record<string, DeliveryQuote>>> {
  const request = quoteRequest(raw);
  if (request === null) return {};
  try {
    return await quoteDelivery(request.address, request.sellerIds);
  } catch {
    return Object.fromEntries(request.sellerIds.map((id) => [id, { kind: 'failed' }]));
  }
}

/** The most lines one order holds, and the most of one line (the cart's own limit is 12). */
const MAX_LINES = 100;
const MAX_QUANTITY = 99;
const TOKEN = /^ctoken_[A-Za-z0-9_]{1,200}$/u;
const CODE = /^[A-Za-z0-9-]{1,32}$/u;
const CURRENCY = /^[A-Z]{3}$/u;

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

/** Own keys of a plain record of up to `max` ids, or null. */
function idsOf(raw: unknown, max: number): string[] | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const ids = Object.keys(raw);
  return ids.length > 0 && ids.length <= max && ids.every((id) => ID.test(id)) ? ids : null;
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
  const lines: Record<string, number> = {};
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
  const delivery: Record<string, PayRequest['delivery'][string]> = {};
  for (const id of sellerIds) {
    const choice = (r.delivery as Record<string, unknown>)[id];
    if (typeof choice !== 'object' || choice === null) return null;
    const { speed, fee } = choice as { speed?: unknown; fee?: unknown };
    if (speed === 'scheduled') delivery[id] = { speed };
    else if (speed === 'express') {
      const paid = money(fee);
      if (paid === null || paid.currency !== total.currency) return null;
      delivery[id] = { speed, fee: paid };
    } else return null;
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
  } catch {
    return { kind: 'failed' };
  }
}
