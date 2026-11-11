// A short in-process cache of the two "does this page exist" reads (SEO package 5, follow-up 2:
// Hassan's M-1). The proxy asks the API whether `/p/<segment>` or `/s/<slug>` exists before any
// HTML is sent, and the page then asks the same read again to render. With this cache the second
// read is answered from memory, so a page that exists costs one API read.
//
// Rules (security review):
// - The key is the Market id plus the API path (which holds the product id or the store slug).
//   The Market comes from the request's listed host, never from the client; two hosts of the same
//   Market share an entry because the API's answer depends only on `x-market-id` (these reads are
//   anonymous: no cookie, no session), and two Markets never do.
// - Only a definite answer is kept: the body of a found page, or the API's own "no such thing"
//   (for a store, the store module's code; for a product, a 404 of the product-detail route, which
//   is what `loadProduct` already reads as "no such product"). A failure, a time-out, a fault or a
//   store's bare 404 is never stored.
// - An entry lives a few seconds and the cache holds at most PAGE_READ_MAX_ENTRIES; the oldest go
//   first. A body larger than PAGE_READ_MAX_BODY_BYTES is not kept, so the cache stays bounded
//   in bytes too (500 x 256 KB at most).
// - A body is kept as its JSON text and each hit parses a fresh copy, so a caller cannot change
//   what the next one reads.
// No server-only marker: the proxy imports it too, and it holds no secret.
import type { ApiRead } from './api.ts';

/** How long an answer is reused: long enough for the proxy and the page of one request. */
export const PAGE_READ_TTL_MS = 8_000;
/** The most entries held; a full cache drops its oldest entry first. */
export const PAGE_READ_MAX_ENTRIES = 500;
/** The largest body kept, as JSON text (UTF-16 units); a larger answer is simply read again. */
export const PAGE_READ_MAX_BODY_BYTES = 256 * 1024;

/** Which answers of a read may be kept: a found page, or the module's own "not found". */
export type KeepRule = (answer: ApiRead<unknown>) => boolean;

/** The product page's read: found, or a 404 of the product-detail route (its "no such product"). */
export const keepProductAnswer: KeepRule = (answer) =>
  answer.kind === 'ok' || (answer.kind === 'failed' && answer.status === 404);

/** The store page's read: found, or the store module's own not-found (never a bare 404). */
export const keepStoreAnswer: KeepRule = (answer) =>
  answer.kind === 'ok' ||
  (answer.kind === 'failed' && answer.status === 404 && answer.code === 'sellers.store-not-found');

/** A kept answer: a found body as JSON text, or the "missing" answer as it was. */
type Kept = { readonly kind: 'ok'; readonly text: string } | ApiRead<unknown>;

interface Entry {
  readonly kept: Kept;
  readonly expires: number;
}

/**
 * One map per process. Next.js bundles the proxy and the pages separately, so a module-level map
 * would be two maps; a global under a registered symbol is the same one for both bundles.
 */
const STORE = Symbol.for('mondapac.storefront.page-read-cache');
type Holder = { [STORE]?: Map<string, Entry> };

function entries(): Map<string, Entry> {
  const holder = globalThis as Holder;
  holder[STORE] ??= new Map();
  return holder[STORE];
}

const keyOf = (marketId: string, path: string): string => `${marketId}\u0000${path}`;

const answerOf = <T>(kept: Kept): ApiRead<T> =>
  'text' in kept ? { kind: 'ok', body: JSON.parse(kept.text) as T } : (kept as ApiRead<T>);

/** The kept answer for this Market and path, if it has not expired. */
export function cachedPageRead<T>(
  marketId: string,
  path: string,
  now: number,
): ApiRead<T> | undefined {
  const map = entries();
  const key = keyOf(marketId, path);
  const entry = map.get(key);
  if (entry === undefined) return undefined;
  if (entry.expires <= now) {
    map.delete(key);
    return undefined;
  }
  return answerOf<T>(entry.kept);
}

/** Keeps the answer when the rule allows it; anything else is left out. */
export function keepPageRead(
  marketId: string,
  path: string,
  answer: ApiRead<unknown>,
  keep: KeepRule,
  now: number,
): void {
  if (answer.kind === 'off' || !keep(answer)) return;
  let kept: Kept = answer;
  if (answer.kind === 'ok') {
    const text = JSON.stringify(answer.body);
    if (text === undefined || text.length > PAGE_READ_MAX_BODY_BYTES) return;
    kept = { kind: 'ok', text };
  }
  const map = entries();
  const key = keyOf(marketId, path);
  map.delete(key);
  // Drop expired entries first, then the oldest, until there is room.
  if (map.size >= PAGE_READ_MAX_ENTRIES) {
    for (const [old, entry] of map) if (entry.expires <= now) map.delete(old);
  }
  while (map.size >= PAGE_READ_MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  map.set(key, { kept, expires: now + PAGE_READ_TTL_MS });
}

/** How many entries are held, for tests. */
export function pageReadCacheSize(): number {
  return entries().size;
}

/** Empties the cache, for tests. */
export function clearPageReadCache(): void {
  entries().clear();
}
