// The buyer site's one relay to the API for the routes that carry the buyer's session or guest
// cart (ADR-0034 decision 3; storefront session design, approved 2026-10-20; the same rules as
// the panels' relay, apps/seller/src/server/bff.ts). Pure functions over `Request` and
// `Response`, so they are tested without a server. Only a closed list of cart, customer-session
// and customer-account paths crosses, only
// the two cookies of the host's Market go to the API and only those two come back, and an unsafe
// request must be same-origin before it is sent on.

import 'server-only';
import {
  CLIENT_ADDRESS_HEADER,
  MissingClientAddressError,
  signForRequest,
} from '@mondapac/panel-server/signer';
import { storefrontHostFor, type StorefrontApiConfig, type StorefrontHost } from './config.ts';

/** The paths the buyer site may reach with cookies, by method: the cart and the customer's own
 * session and account. */
const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  GET: new Set([
    'cart',
    'identity/customer/session',
    // The customer's own address book (customers package 1).
    'customers/me/addresses',
  ]),
  POST: new Set([
    'cart/items',
    'cart/merge',
    'identity/customer/sign-in',
    'identity/customer/sign-out',
    'identity/customer/confirm-email',
    // The customer's own password: the current one and the new one.
    'identity/customer/change-password',
    'customers/me/addresses',
  ]),
  PUT: new Set([
    // The customer's own display name and storefront look (buyer account backend).
    'identity/customer/profile/display-name',
    'identity/customer/profile/appearance',
  ]),
};

/** Paths with one resource id (`:id`, a UUID), by method. */
const ALLOWED_WITH_ID: Readonly<Record<string, readonly string[]>> = {
  POST: ['customers/me/addresses/:id/default'],
  PUT: ['cart/items/:id', 'customers/me/addresses/:id'],
  DELETE: ['cart/items/:id', 'customers/me/addresses/:id'],
};

/** The answers that start a customer session; a guest cart is merged into it right after. */
const SIGNS_IN: ReadonlySet<string> = new Set([
  'identity/customer/sign-in',
  'identity/customer/confirm-email',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function matches(template: string, path: readonly string[]): boolean {
  const parts = template.split('/');
  return (
    parts.length === path.length &&
    parts.every((part, index) =>
      part === ':id' ? UUID.test(path[index] ?? '') : part === path[index],
    )
  );
}

export function isSessionPathAllowed(method: string, path: readonly string[]): boolean {
  if (ALLOWED[method]?.has(path.join('/')) === true) return true;
  return (ALLOWED_WITH_ID[method] ?? []).some((template) => matches(template, path));
}

/** The largest request body the relay passes on. */
const MAX_BODY_BYTES = 16 * 1024;
/** How long the API may take to answer before the relay gives up. */
export const RELAY_TIMEOUT_MS = 5000;
/**
 * The guest-cart merge's own, shorter limit: the sign-in answer and its session cookie wait for
 * it (Hassan, PR #461 finding 1).
 */
export const MERGE_TIMEOUT_MS = 2000;
/** A read (GET) may come from the site itself, a typed address or bookmark, or an old browser. */
const READ_FETCH_SITES: ReadonlySet<string | null> = new Set(['same-origin', 'none', null]);

/** Request headers that cross to the API besides the cookie. Everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'origin',
  'sec-fetch-site',
  'x-csrf-token',
  'user-agent',
] as const;

/** Response headers that cross back to the browser (Set-Cookie is handled on its own). */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'retry-after',
  'x-content-type-options',
] as const;

const CORRELATION_HEADER = 'x-correlation-id';

/** One structured line per failed relay: ids and codes only, never a body, cookie or token. */
export type RelayLog = (line: Record<string, string | number>) => void;
const stdoutLog: RelayLog = (line) => console.log(JSON.stringify(line));

/** The two cookies of a Market that the API reads for a buyer: the session and the guest cart. */
export function sessionCookieNames(marketId: string): {
  readonly session: string;
  readonly guestCart: string;
} {
  return {
    session: `__Host-session-customer-${marketId}`,
    guestCart: `__Host-cart-guest-${marketId}`,
  };
}

/** The `name=value` pairs of a Cookie header. */
function cookiePairs(header: string | null): { name: string; pair: string }[] {
  if (header === null) return [];
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((pair) => ({ name: pair.slice(0, Math.max(pair.indexOf('='), 0)).trim(), pair }));
}

/**
 * The Cookie header for the API: only the Market's session and guest-cart cookies, in the order
 * the browser sent them. A repeated name is kept repeated, so the API refuses it as it would.
 */
export function upstreamCookie(header: string | null, marketId: string): string | null {
  const names = sessionCookieNames(marketId);
  const kept = cookiePairs(header)
    .filter(({ name }) => name === names.session || name === names.guestCart)
    .map(({ pair }) => pair);
  return kept.length === 0 ? null : kept.join('; ');
}

/** The value of one cookie of a Cookie header, or null when it is absent or repeated. */
function cookieValue(header: string | null, name: string): string | null {
  const found = cookiePairs(header).filter((entry) => entry.name === name);
  if (found.length !== 1) return null;
  const pair = found[0]?.pair ?? '';
  return pair.slice(pair.indexOf('=') + 1);
}

/** The name a Set-Cookie value sets. */
const setCookieName = (value: string): string =>
  value.slice(0, Math.max(value.indexOf('='), 0)).trim();

/** The Set-Cookie values of an answer that the browser may receive: the two names only. */
export function passedSetCookies(upstream: Response, marketId: string): string[] {
  const names = sessionCookieNames(marketId);
  return upstream.headers.getSetCookie().filter((value) => {
    const name = setCookieName(value);
    return name === names.session || name === names.guestCart;
  });
}

/** The value a Set-Cookie stores for `name`, or null when it sets none or clears it. */
function setCookieValue(values: readonly string[], name: string): string | null {
  for (const value of values) {
    if (setCookieName(value) !== name) continue;
    const stored =
      value
        .slice(value.indexOf('=') + 1)
        .split(';')[0]
        ?.trim() ?? '';
    return stored === '' ? null : stored;
  }
  return null;
}

const jsonError = (status: number, code: string): Response =>
  new Response(JSON.stringify({ statusCode: status, code }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const notFound = (): Response =>
  new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });

/**
 * Headers for a request to the API: the allowlist, the Market's two cookies, the Market of the
 * host and, with a signing key, the signed client address (ADR-0037). Throws
 * `MissingClientAddressError` when the request did not come through server.mjs.
 */
export function sessionUpstreamHeaders(
  request: Request,
  host: StorefrontHost,
  config: StorefrontApiConfig,
  nowMilliseconds: () => number = Date.now,
): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const cookie = upstreamCookie(request.headers.get('cookie'), host.marketId);
  if (cookie !== null) headers.set('cookie', cookie);
  headers.set('x-market-id', host.marketId);
  if (config.clientAddressKey !== null) {
    headers.set(
      CLIENT_ADDRESS_HEADER,
      signForRequest({
        key: config.clientAddressKey,
        marketId: host.marketId,
        headers: request.headers,
        nowSeconds: Math.floor(nowMilliseconds() / 1000),
      }),
    );
  }
  return headers;
}

/** The request body as text, or null once more than `limit` bytes have arrived. */
async function readCapped(request: Request, limit: number): Promise<string | null> {
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}

/**
 * Right after a sign-in, moves this browser's guest cart into the new session's cart
 * (`POST cart/merge`, the design's decision 3). Answers the Set-Cookie values to add (the cleared
 * guest cookie), or none. A failure is logged and never undoes the sign-in.
 */
async function mergeGuestCart(
  config: StorefrontApiConfig,
  request: Request,
  host: StorefrontHost,
  signedIn: { readonly setCookies: readonly string[]; readonly body: ArrayBuffer },
  fetchImpl: typeof fetch,
  log: RelayLog,
): Promise<string[]> {
  const names = sessionCookieNames(host.marketId);
  const guest = cookieValue(request.headers.get('cookie'), names.guestCart);
  if (guest === null) return [];
  const session = setCookieValue(signedIn.setCookies, names.session);
  let csrfToken: unknown;
  try {
    csrfToken = (JSON.parse(new TextDecoder().decode(signedIn.body)) as { csrfToken?: unknown })
      .csrfToken;
  } catch {
    csrfToken = undefined;
  }
  if (session === null || typeof csrfToken !== 'string') {
    log({ msg: 'storefront.session.merge-skipped', marketId: host.marketId });
    return [];
  }
  const headers = sessionUpstreamHeaders(request, host, config);
  headers.delete('content-type');
  headers.set('accept', 'application/json');
  headers.set('cookie', `${names.session}=${session}; ${names.guestCart}=${guest}`);
  headers.set('x-csrf-token', csrfToken);
  try {
    const merged = await fetchImpl(`${config.apiBaseUrl}/cart/merge`, {
      method: 'POST',
      headers,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(MERGE_TIMEOUT_MS),
    });
    if (!merged.ok) {
      log({
        msg: 'storefront.session.merge-refused',
        status: merged.status,
        marketId: host.marketId,
        correlationId: merged.headers.get(CORRELATION_HEADER) ?? '',
      });
      return [];
    }
    return passedSetCookies(merged, host.marketId);
  } catch {
    log({ msg: 'storefront.session.merge-failed', marketId: host.marketId });
    return [];
  }
}

/**
 * Relays one browser request to the API. `fetchImpl` is injected for tests; the route handler
 * passes the global `fetch`. With the API off (`config` null) nothing is reachable.
 */
export async function relaySession(
  config: StorefrontApiConfig | null,
  request: Request,
  path: readonly string[],
  fetchImpl: typeof fetch = fetch,
  log: RelayLog = stdoutLog,
): Promise<Response> {
  if (config === null) return jsonError(503, 'access.unavailable');
  const host = storefrontHostFor(config, request.headers.get('host'));
  if (host === undefined) return notFound();
  const target = path.join('/');
  if (!isSessionPathAllowed(request.method, path)) return notFound();
  if (request.headers.has('authorization')) return jsonError(401, 'session.invalid');
  if (request.method === 'GET') {
    // A read can still set or clear the guest cookie, so another site never reaches it (Hassan,
    // PR #461 finding 2).
    if (!READ_FETCH_SITES.has(request.headers.get('sec-fetch-site')))
      return jsonError(403, 'request.csrf');
  } else {
    // Unsafe method: same-origin only, whatever the API would do with a missing header.
    if (request.headers.get('sec-fetch-site') !== 'same-origin')
      return jsonError(403, 'request.csrf');
    if (request.headers.get('origin') !== host.origin) return jsonError(403, 'request.csrf');
  }
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return jsonError(413, 'request.too-large');
  let body: string | undefined;
  if (request.method !== 'GET') {
    // Read the stream with a hard cap, so a chunked body without Content-Length is refused too.
    const read = await readCapped(request, MAX_BODY_BYTES);
    if (read === null) return jsonError(413, 'request.too-large');
    body = read;
  }
  let outgoing: Headers;
  try {
    outgoing = sessionUpstreamHeaders(request, host, config);
  } catch (error) {
    if (!(error instanceof MissingClientAddressError)) throw error;
    log({ msg: 'storefront.session.client-address-missing', method: request.method, path: target });
    return jsonError(503, 'access.unavailable');
  }
  let upstream: Response;
  try {
    upstream = await fetchImpl(`${config.apiBaseUrl}/${target}`, {
      method: request.method,
      headers: outgoing,
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch {
    log({
      msg: 'storefront.session.upstream-unreachable',
      method: request.method,
      path: target,
      marketId: host.marketId,
    });
    return jsonError(503, 'access.unavailable');
  }
  if (upstream.status >= 400) {
    log({
      msg: 'storefront.session.error-answer',
      method: request.method,
      path: target,
      status: upstream.status,
      marketId: host.marketId,
      correlationId: upstream.headers.get(CORRELATION_HEADER) ?? '',
    });
  }
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // An answer that carries a buyer's cookies is never cached, whatever the API says.
  headers.set('cache-control', 'private, no-store');
  const setCookies = passedSetCookies(upstream, host.marketId);
  const answer = upstream.status === 204 ? null : await upstream.arrayBuffer();
  if (upstream.status === 200 && SIGNS_IN.has(target) && answer !== null) {
    setCookies.push(
      ...(await mergeGuestCart(
        config,
        request,
        host,
        { setCookies, body: answer },
        fetchImpl,
        log,
      )),
    );
  }
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  return new Response(answer, { status: upstream.status, headers });
}
