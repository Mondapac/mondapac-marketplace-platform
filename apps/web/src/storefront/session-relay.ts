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
    // The signed-in customer's saved-for-later list (cart v4).
    'cart/saved',
    'identity/customer/session',
    // The customer's own address book (customers package 1).
    'customers/me/addresses',
    // Whether the customer may delete the account, and their open deletion request, if any
    // (customers package 5a and 5b; screens: account deletion).
    'customers/me/account-deletion',
    'customers/me/deletion-requests/current',
    // The buyer's own reviews: what waits for one, and what was written (reviews package 3).
    'reviews/me/to-review',
    'reviews/me',
    // Whether the buyer assistant shows to this visitor (`?visitor=&lang=` only; see ASSISTANT).
    'assistant/storefront',
    // The customer's followed stores (My stores; `?cursor=&limit=` only) and the store they joined
    // through (customers management phases 3 and 4a).
    'customers/me/followed-stores',
    'customers/me/store-invitation',
  ]),
  POST: new Set([
    'cart/items',
    'cart/merge',
    'cart/saved',
    'identity/customer/sign-in',
    'identity/customer/sign-out',
    'identity/customer/confirm-email',
    // The customer's own password: the current one and the new one.
    'identity/customer/change-password',
    'customers/me/addresses',
    // The customer joins a store through its invite link (body `{ token }`).
    'customers/me/store-invitation',
    // The customer asks to delete the account (the request waits, then the job erases it).
    'customers/me/deletion-requests',
    // The delivery methods and prices of the basket for a saved address (delivery models, pkg 5).
    'orders/delivery-quotes',
    // The buyer writes a product review (reviews package 3).
    'reviews/products',
  ]),
  PUT: new Set([
    // The customer's own display name and storefront look (buyer account backend).
    'identity/customer/profile/display-name',
    'identity/customer/profile/appearance',
    'identity/customer/profile/language',
  ]),
  DELETE: new Set([
    // The customer cancels their own pending deletion request.
    'customers/me/deletion-requests/current',
  ]),
};

/** Paths with one resource id (`:id`, a UUID), by method. */
const ALLOWED_WITH_ID: Readonly<Record<string, readonly string[]>> = {
  GET: [
    // Whether the customer follows one store, and the store's Follow gift (public).
    'customers/me/followed-stores/:id',
    'promotions/stores/:id/follow-gift',
  ],
  POST: [
    'customers/me/addresses/:id/default',
    'cart/saved/:id/move-to-cart',
    // The buyer rates one delivered seller order.
    'reviews/seller-orders/:id/rating',
    // One message to the buyer assistant; the answer is a `text/event-stream`.
    'assistant/conversations/:id/messages',
  ],
  // The buyer edits their own review.
  PATCH: ['reviews/products/:id'],
  PUT: ['cart/items/:id', 'customers/me/addresses/:id', 'customers/me/followed-stores/:id'],
  DELETE: [
    'customers/me/followed-stores/:id',
    'cart/items/:id',
    'customers/me/addresses/:id',
    'cart/saved/:id',
    'reviews/products/:id',
  ],
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

/** A store address, as the public store read takes it (`GET sellers/stores/:slug`). */
const STORE_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isSessionPathAllowed(method: string, path: readonly string[]): boolean {
  if (ALLOWED[method]?.has(path.join('/')) === true) return true;
  // My stores names each row by its public store read (name and logo).
  if (
    method === 'GET' &&
    path.length === 3 &&
    path[0] === 'sellers' &&
    path[1] === 'stores' &&
    path[2] !== undefined &&
    path[2].length <= 50 &&
    STORE_SLUG.test(path[2])
  )
    return true;
  return (ALLOWED_WITH_ID[method] ?? []).some((template) => matches(template, path));
}

/**
 * The buyer assistant's two routes (F1). They get a few things no other relayed path gets: the
 * assistant's own guest cookie both ways, the `x-assistant-preview` request header, the two query
 * parameters of the storefront read and the longer wait of a model answer. Nothing else changes.
 */
export const isAssistantPath = (path: readonly string[]): boolean => path[0] === 'assistant';

/** The server gives up on a model answer at 25 s; the relay waits a little longer than that. */
export const ASSISTANT_TIMEOUT_MS = 30_000;

/** The preview token's header, and the shape a token must have to cross (never logged). */
const PREVIEW_HEADER = 'x-assistant-preview';
const PREVIEW_SHAPE = /^[A-Za-z0-9._-]{20,300}$/;

const VISITOR_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;
const LANG_SHAPE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

/**
 * The query the storefront read passes on: `visitor` and `lang`, each only when well shaped, and
 * nothing else. Any other path takes no query (the relay never forwarded one).
 */
export function assistantQuery(url: string): string {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return '';
  }
  const kept = new URLSearchParams();
  const visitor = params.get('visitor');
  if (visitor !== null && VISITOR_SHAPE.test(visitor)) kept.set('visitor', visitor);
  const lang = params.get('lang');
  if (lang !== null && LANG_SHAPE.test(lang)) kept.set('lang', lang);
  const text = kept.toString();
  return text === '' ? '' : `?${text}`;
}

const CURSOR_SHAPE = /^[A-Za-z0-9._~=-]{1,300}$/;
const LIMIT_SHAPE = /^[0-9]{1,3}$/;

/** My stores' query: `cursor` and `limit`, each only when well shaped, and nothing else. */
export function myStoresQuery(url: string): string {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return '';
  }
  const kept = new URLSearchParams();
  const cursor = params.get('cursor');
  if (cursor !== null && CURSOR_SHAPE.test(cursor)) kept.set('cursor', cursor);
  const limit = params.get('limit');
  if (limit !== null && LIMIT_SHAPE.test(limit)) kept.set('limit', limit);
  const text = kept.toString();
  return text === '' ? '' : `?${text}`;
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
  /** The assistant's own guest cookie; crosses on the assistant routes only. */
  readonly assistantGuest: string;
} {
  return {
    session: `__Host-session-customer-${marketId}`,
    guestCart: `__Host-cart-guest-${marketId}`,
    assistantGuest: `__Host-assistant-guest-${marketId}`,
  };
}

/** Which cookies a path may carry: the cart and session ones, or the session and assistant ones. */
export type CookieScope = 'session' | 'assistant';

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
export function upstreamCookie(
  header: string | null,
  marketId: string,
  scope: CookieScope = 'session',
): string | null {
  const names = sessionCookieNames(marketId);
  const allowed =
    scope === 'assistant'
      ? [names.session, names.assistantGuest]
      : [names.session, names.guestCart];
  const kept = cookiePairs(header)
    .filter(({ name }) => allowed.includes(name))
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
export function passedSetCookies(
  upstream: Response,
  marketId: string,
  scope: CookieScope = 'session',
): string[] {
  const names = sessionCookieNames(marketId);
  const allowed =
    scope === 'assistant'
      ? [names.session, names.assistantGuest]
      : [names.session, names.guestCart];
  return upstream.headers.getSetCookie().filter((value) => allowed.includes(setCookieName(value)));
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
  scope: CookieScope = 'session',
): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const cookie = upstreamCookie(request.headers.get('cookie'), host.marketId, scope);
  if (cookie !== null) headers.set('cookie', cookie);
  if (scope === 'assistant') {
    // The internal preview token: only on the assistant routes, only when well shaped.
    const preview = request.headers.get(PREVIEW_HEADER);
    if (preview !== null && PREVIEW_SHAPE.test(preview)) headers.set(PREVIEW_HEADER, preview);
  }
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

/** The most of an upstream answer the relay holds in memory: the assistant's, and every other. */
const MAX_ASSISTANT_ANSWER_BYTES = 256 * 1024;
const MAX_ANSWER_BYTES = 1024 * 1024;

/** Reads an upstream body with a hard cap; `null` when it is over. Throws on abort or timeout. */
async function readAnswerCapped(response: Response, limit: number): Promise<ArrayBuffer | null> {
  if (response.body === null) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

/** A path segment that could smuggle a separator, an encoding or a dot-segment past the allow-list. */
const unsafeSegment = (segment: string): boolean =>
  segment === '' || segment === '.' || segment === '..' || /[/\\%]/.test(segment);

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
  if (path.some(unsafeSegment)) return notFound();
  const target = path.join('/');
  const assistant = target === 'assistant' || target.startsWith('assistant/');
  const scope: CookieScope = assistant ? 'assistant' : 'session';
  // What is logged: the route, never the conversation id.
  const logged =
    assistant && path[1] === 'conversations' ? 'assistant/conversations/:id/messages' : target;
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
    outgoing = sessionUpstreamHeaders(request, host, config, Date.now, scope);
  } catch (error) {
    if (!(error instanceof MissingClientAddressError)) throw error;
    log({
      msg: 'storefront.session.client-address-missing',
      method: request.method,
      path: logged,
    });
    return jsonError(503, 'access.unavailable');
  }
  let upstream: Response;
  try {
    const query =
      target === 'assistant/storefront'
        ? assistantQuery(request.url)
        : target === 'customers/me/followed-stores'
          ? myStoresQuery(request.url)
          : '';
    upstream = await fetchImpl(`${config.apiBaseUrl}/${target}${query}`, {
      method: request.method,
      headers: outgoing,
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(assistant ? ASSISTANT_TIMEOUT_MS : RELAY_TIMEOUT_MS),
    });
  } catch {
    log({
      msg: 'storefront.session.upstream-unreachable',
      method: request.method,
      path: logged,
      marketId: host.marketId,
    });
    return jsonError(503, 'access.unavailable');
  }
  if (upstream.status >= 400) {
    log({
      msg: 'storefront.session.error-answer',
      method: request.method,
      path: logged,
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
  const setCookies = passedSetCookies(upstream, host.marketId, scope);
  let answer: ArrayBuffer | null = null;
  if (upstream.status !== 204) {
    try {
      answer = await readAnswerCapped(
        upstream,
        assistant ? MAX_ASSISTANT_ANSWER_BYTES : MAX_ANSWER_BYTES,
      );
    } catch {
      log({
        msg: 'storefront.session.upstream-unreachable',
        method: request.method,
        path: logged,
        marketId: host.marketId,
      });
      return jsonError(503, 'access.unavailable');
    }
    if (answer === null) {
      log({
        msg: 'storefront.session.answer-too-large',
        method: request.method,
        path: logged,
        marketId: host.marketId,
      });
      return jsonError(502, 'access.unavailable');
    }
  }
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
