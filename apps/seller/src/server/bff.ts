// The panel server's relay to the API (ADR-0034 decision 3). Pure functions over `Request` and
// `Response`, so they are tested without a server. The relay forwards an allowlist of paths and
// headers, sets `x-market-id` from the request host, and refuses an unsafe request that is not
// same-origin, because the API's own origin check is fail-open when the headers are absent.

import 'server-only';
import {
  CLIENT_ADDRESS_HEADER,
  MissingClientAddressError,
  signForRequest,
} from '@mondapac/panel-server/signer';
import type { PanelConfig, PanelHost } from './config.ts';

/** The paths this panel may reach, by method (its own population's identity routes). */
const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  GET: new Set([
    'identity/seller/session',
    'identity/seller/status',
    // The team list (query: `after`) and the roles the team screens offer.
    'identity/seller/team',
    'identity/seller/roles',
    'sellers/my-file',
    'sellers/my-file/form-descriptors',
    'payments/seller/payout-account',
    'ordering/seller/orders',
  ]),
  PUT: new Set([
    'sellers/my-file/general',
    'sellers/my-file/address',
    'sellers/my-file/slug',
    'sellers/my-file/identifier',
    'inventory/seller/sources-order',
  ]),
  POST: new Set([
    'identity/seller/sign-up',
    'identity/seller/confirm-email',
    'identity/seller/verification-email',
    'identity/seller/sign-in',
    'identity/seller/sign-in/second-factor',
    'identity/seller/second-factor/enrolment',
    'identity/seller/second-factor/enrolment/confirm',
    'identity/seller/second-factor/remove',
    'identity/seller/second-factor/recovery-codes',
    // Anonymous: the one-time token of the owner's reset link is in the body (slice 12, A11).
    'identity/seller/second-factor/reset/confirm',
    'identity/seller/sign-out',
    'identity/seller/team/invitations',
    // Anonymous: the one-time token of the invitation link is in the body.
    'identity/seller/accept-invitation',
    'identity/seller/password-reset-email',
    'identity/seller/reset-password',
    'identity/seller/change-password',
    'sellers/my-file/slug-check',
    'sellers/my-file/submit',
    'sellers/my-file/withdraw',
    'inventory/seller/sources',
    'catalog/seller/products',
    // Each asks for a second-factor code in the body and answers with a one-time Stripe address.
    'payments/seller/payout-account',
    'payments/seller/payout-account/link',
  ]),
};

/**
 * Paths with one resource id (`:id`, a UUID), by method. Still exact: each segment must match
 * the template, and the id must be a UUID, so no other path shape reaches the API.
 */
const ALLOWED_WITH_ID: Readonly<Record<string, readonly string[]>> = {
  PUT: [
    'inventory/seller/sources/:id',
    'catalog/seller/products/:id/draft',
    'catalog/seller/offers/:id',
    'inventory/seller/offers/:id/variants/:id/sources/:id/stock',
    'pricing/seller/offers/:id/variants/:id/regular-price',
    'pricing/seller/offers/:id/variants/:id/special-price',
  ],
  POST: [
    'identity/seller/team/invitations/:id/resend',
    'identity/seller/team/invitations/:id/revoke',
    'identity/seller/team/accounts/:id/role',
    'identity/seller/team/accounts/:id/remove',
    'catalog/seller/products/:id/submit',
    'catalog/seller/products/:id/images',
    'catalog/seller/offers/:id/submit',
    'ordering/seller/orders/:id/ship',
    'ordering/seller/orders/:id/deliver',
    'pricing/seller/offers/:id/variants/:id/special-price/withdraw',
  ],
  DELETE: ['catalog/seller/offers/:id', 'catalog/seller/products/:id/images/:id'],
  // A product photo for the panel's <img> tags: the API serves a JPEG it wrote itself.
  GET: ['catalog/seller/products/:id/images/:id/:size'],
};

/** The only GET paths whose query string crosses to the API, and the keys that may cross. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Per GET target, the query keys passed on and, where set, the shape each value must have. */
const QUERY_KEYS: Readonly<Record<string, Readonly<Record<string, RegExp | null>>>> = {
  'ordering/seller/orders': { limit: null, cursor: null },
  'identity/seller/team': { after: UUID },
};
const QUERY_VALUE_MAX = 512;

/** The allowed keys of the request's query, capped in length; everything else is dropped. */
function upstreamQuery(method: string, target: string, requestUrl: string): string {
  const keys = method === 'GET' ? QUERY_KEYS[target] : undefined;
  if (keys === undefined) return '';
  const source = new URL(requestUrl).searchParams;
  const kept = new URLSearchParams();
  for (const [key, shape] of Object.entries(keys)) {
    const value = source.get(key);
    if (value === null || value.length > QUERY_VALUE_MAX) continue;
    if (shape === null || shape.test(value)) kept.set(key, value);
  }
  const text = kept.toString();
  return text === '' ? '' : `?${text}`;
}

/** The photo sizes the panel may ask for; the API names the same three. */
const PHOTO_SIZES: ReadonlySet<string> = new Set(['thumb', 'medium', 'large']);

function matches(template: string, path: readonly string[]): boolean {
  const parts = template.split('/');
  return (
    parts.length === path.length &&
    parts.every((part, index) =>
      part === ':id'
        ? UUID.test(path[index] ?? '')
        : part === ':size'
          ? PHOTO_SIZES.has(path[index] ?? '')
          : part === path[index],
    )
  );
}

function isAllowed(method: string, path: readonly string[]): boolean {
  if (ALLOWED[method]?.has(path.join('/')) === true) return true;
  return (ALLOWED_WITH_ID[method] ?? []).some((template) => matches(template, path));
}

/** The largest request body the relay passes on: 16 KiB, but a photo upload may carry 5.8 MiB. */
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PHOTO_BODY_BYTES = 5800 * 1024;
const PHOTO_UPLOAD = 'catalog/seller/products/:id/images';

function bodyLimitFor(method: string, path: readonly string[]): number {
  return method === 'POST' && matches(PHOTO_UPLOAD, path) ? MAX_PHOTO_BODY_BYTES : MAX_BODY_BYTES;
}

/** Request headers that cross to the API. Everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = [
  'cookie',
  'content-type',
  'accept',
  'origin',
  'sec-fetch-site',
  'x-csrf-token',
] as const;

/** Response headers that cross back to the browser (Set-Cookie is handled on its own). */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'retry-after',
  'x-content-type-options',
] as const;

/** The API issues the correlation id and returns it in this header (ADR-0034 decision 3). */
const CORRELATION_HEADER = 'x-correlation-id';

/** One structured line per failed relay: ids and codes only, never a body, cookie or token. */
export type RelayLog = (line: Record<string, string | number>) => void;
const stdoutLog: RelayLog = (line) => console.log(JSON.stringify(line));

/** Lower case, no trailing dot on the host name; the port stays. */
export function normaliseHost(raw: string | null): string | null {
  if (raw === null) return null;
  const host = raw.trim().toLowerCase();
  if (host === '') return null;
  return host.replace(/\.(?=$|:)/, '');
}

export function panelHostFor(config: PanelConfig, rawHost: string | null): PanelHost | undefined {
  const host = normaliseHost(rawHost);
  return host === null ? undefined : config.hosts.find((entry) => entry.host === host);
}

const jsonError = (status: number, code: string): Response =>
  new Response(JSON.stringify({ statusCode: status, code }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const notFound = (): Response =>
  new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });

/**
 * Headers for a request to the API: the allowlist plus the Market of the host, and, when this
 * panel has a signing key, the signed client address (ADR-0037). The browser's own
 * `x-client-address` is never forwarded; the signer reads only `x-mp-client-address`, which
 * `server.mjs` sets, and throws `MissingClientAddressError` when it is absent.
 */
export function upstreamHeaders(
  request: Request,
  host: PanelHost,
  config: PanelConfig,
  nowMilliseconds: () => number = Date.now,
): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
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

/**
 * Relays one browser request to the API. `fetchImpl` is injected for tests; the route handler
 * passes the global `fetch`.
 */
export async function relay(
  config: PanelConfig,
  request: Request,
  path: readonly string[],
  fetchImpl: typeof fetch = fetch,
  log: RelayLog = stdoutLog,
): Promise<Response> {
  const host = panelHostFor(config, request.headers.get('host'));
  if (host === undefined) return notFound();
  const target = path.join('/');
  if (!isAllowed(request.method, path)) return notFound();
  if (request.headers.has('authorization')) return jsonError(401, 'session.invalid');
  if (request.method !== 'GET') {
    // Unsafe method: same-origin only, whatever the API would do with a missing header.
    if (request.headers.get('sec-fetch-site') !== 'same-origin')
      return jsonError(403, 'request.csrf');
    if (request.headers.get('origin') !== host.origin) return jsonError(403, 'request.csrf');
  }
  const limit = bodyLimitFor(request.method, path);
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > limit) return jsonError(413, 'request.too-large');
  let body: string | undefined;
  if (request.method !== 'GET') {
    // Read the stream with a hard cap, so a chunked body without Content-Length is refused too.
    const read = await readCapped(request, limit);
    if (read === null) return jsonError(413, 'request.too-large');
    body = read;
  }
  let outgoing: Headers;
  try {
    outgoing = upstreamHeaders(request, host, config);
  } catch (error) {
    if (!(error instanceof MissingClientAddressError)) throw error;
    log({ msg: 'panel.relay.client-address-missing', method: request.method, path: target });
    return jsonError(503, 'access.unavailable');
  }
  let upstream: Response;
  try {
    upstream = await fetchImpl(
      `${config.apiBaseUrl}/${target}${upstreamQuery(request.method, target, request.url)}`,
      {
        method: request.method,
        headers: outgoing,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        cache: 'no-store',
      },
    );
  } catch {
    log({
      msg: 'panel.relay.upstream-unreachable',
      method: request.method,
      path: target,
      marketId: host.marketId,
    });
    return jsonError(503, 'access.unavailable');
  }
  if (upstream.status >= 400) {
    log({
      msg: 'panel.relay.error-answer',
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
  // Session answers must never be cached; the API sets no-store itself, this is the default.
  headers.set('cache-control', upstream.headers.get('cache-control') ?? 'private, no-store');
  for (const cookie of upstream.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(upstream.status === 204 ? null : await upstream.arrayBuffer(), {
    status: upstream.status,
    headers,
  });
}
