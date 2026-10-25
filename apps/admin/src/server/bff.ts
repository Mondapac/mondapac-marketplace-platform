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
    'identity/admin/session',
    'identity/admin/sellers',
    'payments/admin/connected-accounts',
    // The Market's orders (ordering), read-only: the list; one order is read by the page server.
    'ordering/admin/orders',
    // The Market's buyer assistant settings, read again after another admin saved first.
    'assistant/admin/settings',
    // The topbar bell (in-app notifications package 3): the list (query: `show`, `before`) and
    // the unread count with the newest unread notice.
    'notifications/admin/notices',
    'notifications/admin/notices/unread-count',
    // The storefront slide library (storefront), read-only: the list (query: `state`, `position`);
    // one slide is read by the page server.
    'storefront/admin/slides',
  ]),
  // The Market's support email (notifications): a body of one field, set by an admin.
  PUT: new Set([
    'notifications/admin/support-contact',
    // The signed-in admin's own display name (profile).
    'identity/admin/profile/display-name',
    // The signed-in admin's own time zone and language (profile).
    'identity/admin/profile/preferences',
    // The Market's buyer assistant settings (assistant): every field with `expectedVersion`.
    'assistant/admin/settings',
    // The order of the live slides of one position (storefront). A fixed path, so `order` is never
    // read as a slide id: the slide route below takes a UUID only.
    'storefront/admin/slides/order',
  ]),
  DELETE: new Set([]),
  POST: new Set([
    // The signed-in admin's other sessions are ended; this one stays (profile).
    'identity/admin/profile/sessions/sign-out-others',
    'identity/admin/sign-in',
    'identity/admin/second-factor',
    'identity/admin/sign-out',
    'identity/admin/invitations',
    'identity/admin/password-reset-email',
    'identity/admin/reset-password',
    // The signed-in admin's own password; the body carries a code from the app.
    'identity/admin/change-password',
    'identity/admin/invitation/enrolment',
    'identity/admin/invitation/accept',
    'identity/admin/roles',
    // A read with the address in the body, so it stays out of URLs and logs (slice 8d).
    'identity/admin/customers/lookup',
    // A read with the search term in the body, so a POST (sellers design 7.8).
    'sellers/admin/list',
    'notifications/admin/notices/read-all',
    // A new storefront slide, as a draft (storefront).
    'storefront/admin/slides',
  ]),
};

/**
 * Paths with one resource id (`:id`, a UUID), by method. Still exact: each segment must match
 * the template, and the id must be a UUID, so no other path shape reaches the API.
 */
const ALLOWED_WITH_ID: Readonly<Record<string, readonly string[]>> = {
  POST: [
    'identity/admin/accounts/:id/disable',
    'identity/admin/accounts/:id/enable',
    'identity/admin/accounts/:id/role',
    'identity/admin/accounts/:id/second-factor/reset',
    'identity/admin/customers/:id/disable',
    'identity/admin/customers/:id/enable',
    'identity/admin/invitations/:id/resend',
    'identity/admin/invitations/:id/revoke',
    'identity/admin/sellers/:id/invitations',
    'identity/admin/sellers/:id/second-factor/reset',
    'sellers/admin/:id/review/approve',
    'sellers/admin/:id/review/reject',
    'pricing/admin/price-holds/:id/approve',
    'pricing/admin/price-holds/:id/reject',
    'catalog/admin/offers/:id/approve',
    'catalog/admin/offers/:id/request-changes',
    'notifications/admin/notices/:id/read',
    // A storefront slide's approval side and its other changes (storefront): send the draft for
    // approval, approve it, pause, resume, archive, and copy an earlier version into the draft.
    'storefront/admin/slides/:id/submit',
    'storefront/admin/slides/:id/approve',
    'storefront/admin/slides/:id/pause',
    'storefront/admin/slides/:id/resume',
    'storefront/admin/slides/:id/archive',
    'storefront/admin/slides/:id/restore',
  ],
  PUT: [
    'identity/admin/roles/:id',
    'sellers/admin/:id/review/manual-register-check',
    // The seller's flat delivery fee (shipping), set from the seller review page.
    'shipping/admin/sellers/:id/flat-fee',
    // The seller's own commission rate (commission-payouts), set from the seller review page.
    'commission-payouts/admin/sellers/:id/commission-rate',
    // A storefront slide's whole draft (storefront).
    'storefront/admin/slides/:id',
  ],
  DELETE: ['identity/admin/roles/:id', 'commission-payouts/admin/sellers/:id/commission-rate'],
  // The seller's commission rate and ledger, read from the seller review page.
  GET: [
    'commission-payouts/admin/sellers/:id/commission-rate',
    'commission-payouts/admin/sellers/:id/ledger',
    // A storefront slide as a package to create in another Market (storefront).
    'storefront/admin/slides/:id/copy',
  ],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The only GET paths whose query string crosses to the API, and the keys that may cross. */
const QUERY_KEYS: Readonly<Record<string, readonly string[]>> = {
  'identity/admin/sellers': ['state', 'limit', 'after'],
  'payments/admin/connected-accounts': ['status', 'cursor'],
  'ordering/admin/orders': ['status', 'cursor'],
  'notifications/admin/notices': ['show', 'before'],
  'storefront/admin/slides': ['state', 'position'],
};
/** Query values that must have a shape to cross; a value of another shape is dropped. */
const QUERY_SHAPES: Readonly<Record<string, Readonly<Record<string, RegExp>>>> = {
  'notifications/admin/notices': { show: /^(unread|read|all)$/, before: UUID },
  'storefront/admin/slides': {
    state: /^(draft|pending|scheduled|live|ended|paused|archived)$/,
    position: /^[a-z]+(?:\.[a-z-]+)+$/,
  },
};
/** GET templates with a resource id whose query crosses, and the keys that may cross. */
const QUERY_KEYS_WITH_ID: Readonly<Record<string, readonly string[]>> = {
  'commission-payouts/admin/sellers/:id/ledger': ['limit', 'cursor'],
};
const QUERY_VALUE_MAX = 512;

/** The allowed keys of the request's query, capped in length; everything else is dropped. */
function upstreamQuery(method: string, target: string, requestUrl: string): string {
  // The relay allows an id segment only when it is a UUID, so the template is the path with
  // each UUID segment named `:id`.
  const template = target
    .split('/')
    .map((part) => (UUID.test(part) ? ':id' : part))
    .join('/');
  const keys = method === 'GET' ? (QUERY_KEYS[target] ?? QUERY_KEYS_WITH_ID[template]) : undefined;
  if (keys === undefined) return '';
  const source = new URL(requestUrl).searchParams;
  const shapes = QUERY_SHAPES[target];
  const kept = new URLSearchParams();
  for (const key of keys) {
    const value = source.get(key);
    if (value === null || value.length > QUERY_VALUE_MAX) continue;
    if (shapes?.[key]?.test(value) !== false) kept.set(key, value);
  }
  const text = kept.toString();
  return text === '' ? '' : `?${text}`;
}

function isAllowed(method: string, path: readonly string[]): boolean {
  if (ALLOWED[method]?.has(path.join('/')) === true) return true;
  return (ALLOWED_WITH_ID[method] ?? []).some((template) => {
    const parts = template.split('/');
    return (
      parts.length === path.length &&
      parts.every((part, index) =>
        part === ':id' ? UUID.test(path[index] ?? '') : part === path[index],
      )
    );
  });
}

/** Request headers that cross to the API. Everything else is dropped. */
const FORWARDED_REQUEST_HEADERS = [
  'cookie',
  'content-type',
  'accept',
  'origin',
  'sec-fetch-site',
  'x-csrf-token',
  // The API keeps only a coarse browser and system code of it on a new session (profile).
  'user-agent',
] as const;

/** Response headers that cross back to the browser (Set-Cookie is handled on its own). */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'retry-after'] as const;

/** The API issues the correlation id and returns it in this header (ADR-0034 decision 3). */
const CORRELATION_HEADER = 'x-correlation-id';

/** One structured line per failed relay: ids and codes only, never a body, cookie or token. */
export type RelayLog = (line: Record<string, string | number>) => void;
const stdoutLog: RelayLog = (line) => console.log(JSON.stringify(line));

const MAX_BODY_BYTES = 16 * 1024;

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
