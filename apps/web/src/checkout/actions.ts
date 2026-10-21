'use server';

import { checkDeliveryArea, quoteDelivery } from '../storefront/source.ts';
import type { DeliveryAreaAnswer, DeliveryQuote, QuoteAddress } from '../storefront/types.ts';

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
  if (typeof address !== 'object' || address === null) return null;
  const { kind, id, postcode } = address as { kind?: unknown; id?: unknown; postcode?: unknown };
  if (kind === 'saved' && typeof id === 'string' && ID.test(id))
    return { address: { kind, id }, sellerIds: sellerIds as string[] };
  if (kind === 'new' && typeof postcode === 'string' && POSTCODE.test(postcode.trim()))
    return { address: { kind, postcode: postcode.trim() }, sellerIds: sellerIds as string[] };
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
