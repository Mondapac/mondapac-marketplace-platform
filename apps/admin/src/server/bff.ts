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
    // The Market's support email, read again after another admin saved first.
    'notifications/admin/support-contact',
    // The topbar bell (in-app notifications package 3): the list (query: `show`, `before`) and
    // the unread count with the newest unread notice.
    'notifications/admin/notices',
    'notifications/admin/notices/unread-count',
    // The fleet-selection models, the active model per method and the fleets (shipping), read
    // again after a save.
    'shipping/admin/fleet-selection',
    // The storefront slide library (storefront), read-only: the list (query: `state`, `position`);
    // one slide is read by the page server.
    'storefront/admin/slides',
    // The saved order of the live slides of one position (storefront), read-only (query:
    // `position`, `scope`, `scopeId`). A fixed path, so `order` is never read as a slide id: the
    // slide route reads a UUID only, and one slide is read by the page server.
    'storefront/admin/slides/order',
    // The Market's wallet switch, and the admin credit requests (query: `status`, `cursor`, `limit`).
    'wallet/admin/settings',
    'wallet/admin/credit-requests',
    // The payment dispute cases (commission-payouts), read-only list (query: `filter`, `cursor`,
    // `limit`); one case is read by the page server and again after a decision.
    'commission-payouts/admin/disputes',
    // The buyer-review moderation queue (reviews), read-only list (query: `tab`, `cursor`,
    // `limit`); one review is read by its dialog and again after an action.
    'reviews/admin/moderation',
    // The seller payouts (commission-payouts, package 6d), read-only list (query: `status`,
    // `cursor`, `limit`); one payout is read by the page server and again by the approve dialog.
    'commission-payouts/admin/payouts',
    // The delivery settings of the Market (shipping), read again after a conflict.
    'shipping/admin/delivery-settings',
    // The marketplace product list (catalog), read-only (query: `view`, `q`, the filters, `sort`,
    // `direction`, `page`, `pageSize`); and the public category tree, which names its filter.
    'catalog/admin/products',
    'catalog/categories',
    // The export of the product list as a file (catalog): the chosen ids or the list's own query.
    'catalog/admin/products/export',
    // Import products (catalog): the CSV and XLSX templates and the admin's current import.
    'catalog/admin/platform-imports/template',
    'catalog/admin/platform-imports/current',
    // The saved views of the product list (catalog), read-only (query: `listKey`).
    'catalog/admin/saved-filters',
    // The buyer account deletion setting, read again after a conflict, and the pending deletion
    // requests (customers; query: `cursor`, `limit`).
    'customers/admin/account-deletion-settings',
    'customers/admin/deletion-requests',
    // The brands (catalog; query: `status`, `search`, `afterId`, `limit`) and the brand merge
    // queue. One brand is not read by the panel: the list rows carry the version a change needs.
    'catalog/admin/brands',
    'catalog/admin/brands/merge-queue',
    // The business activities (catalog; query: `status`, `search`, `afterId`, `limit`).
    'catalog/admin/business-activities',
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
    // Fleet selection (shipping): the whole page in one batch (the active model per delivery
    // method and the reliability per fleet), with `expectedVersion`.
    'shipping/admin/fleet-selection',
    // The order of the live slides of one position (storefront). A fixed path, so `order` is never
    // read as a slide id: the slide route below takes a UUID only.
    'storefront/admin/slides/order',
    // The Market's wallet switch (wallet), behind a fresh two-step code.
    'wallet/admin/settings',
    // The delivery settings of the Market (shipping): the whole set, with `expectedVersion`.
    'shipping/admin/delivery-settings',
    // The buyer account deletion setting (customers), behind a fresh two-step code.
    'customers/admin/account-deletion-settings',
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
    // The signed-in admin moves their own authenticator to a new device: a code from the current
    // app starts it, a code from the new one completes it (the session continues with a new
    // cookie, which the relay passes on).
    'identity/admin/second-factor/replacement',
    'identity/admin/second-factor/replacement/confirm',
    'identity/admin/invitation/enrolment',
    'identity/admin/invitation/accept',
    'identity/admin/roles',
    // A read with the address in the body, so it stays out of URLs and logs (slice 8d).
    'identity/admin/customers/lookup',
    // A read with the search term in the body, so a POST (sellers design 7.8).
    'sellers/admin/list',
    'notifications/admin/notices/read-all',
    // A new fleet-selection model (shipping).
    'shipping/admin/fleet-selection/models',
    // A new storefront slide, as a draft (storefront).
    'storefront/admin/slides',
    // Admin store credit (wallet), behind a fresh two-step code.
    'wallet/admin/credits',
    // A fresh two-step code for one admin action (identity).
    'identity/admin/step-up/verify',
    // A new brand (catalog), and keeping a group of the merge queue apart.
    'catalog/admin/brands',
    'catalog/admin/brands/merge-queue/dismiss',
    // A new business activity (catalog).
    'catalog/admin/business-activities',
    // The Bulk action menu of the product list (catalog): Activate, Deactivate and Delete over
    // the chosen products (at most 200 ids) or the whole filter; the body is capped at 16 KB.
    'catalog/admin/products/bulk',
    // Import products (catalog): the checked file, as base64 in a JSON body (the one path with a
    // larger body cap, see UPLOAD_PATH).
    'catalog/admin/platform-imports',
    // Save the product list's current view as a tab (catalog): a closed body, for me or everyone.
    'catalog/admin/saved-filters',
  ]),
};

/**
 * Paths with one resource id (`:id`, a UUID), by method. Still exact: each segment must match
 * the template, and the id must be a UUID, so no other path shape reaches the API.
 */
const ALLOWED_WITH_ID: Readonly<Record<string, readonly string[]>> = {
  POST: [
    // Start, resume or discard one checked import (catalog).
    'catalog/admin/platform-imports/:id/start',
    'catalog/admin/platform-imports/:id/resume',
    'catalog/admin/platform-imports/:id/discard',
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
    // A brand (catalog): approve a seller's proposal, archive (also turns a proposal down), and
    // merge other brands into it.
    'catalog/admin/brands/:id/approve',
    'catalog/admin/brands/:id/archive',
    'catalog/admin/brands/:id/merge',
    'notifications/admin/notices/:id/read',
    // A storefront slide's approval side and its other changes (storefront): send the draft for
    // approval, approve it, pause, resume, archive, and copy an earlier version into the draft.
    'storefront/admin/slides/:id/submit',
    'storefront/admin/slides/:id/approve',
    'storefront/admin/slides/:id/pause',
    'storefront/admin/slides/:id/resume',
    'storefront/admin/slides/:id/archive',
    'storefront/admin/slides/:id/restore',
    // Approve or reject another admin's credit request (wallet), behind a two-step code.
    'wallet/admin/credit-requests/:id/approve',
    'wallet/admin/credit-requests/:id/reject',
    // Who bears a lost chargeback, per seller order (commission-payouts), behind a two-step code.
    'commission-payouts/admin/disputes/:id/seller-orders/:id/decision',
    // Approve a seller payout that waits (commission-payouts), behind a two-step code; the body
    // echoes the transfer amount the admin saw.
    'commission-payouts/admin/payouts/:id/approve',
    // Place a hold on a seller, and release one (commission-payouts), behind a two-step code.
    'commission-payouts/admin/sellers/:id/payout-holds',
    'commission-payouts/admin/payout-holds/:id/release',
    // Delete a buyer's account for them, from a support ticket (customers), behind a two-step code.
    'customers/admin/buyers/:id/deletion-requests',
    // Publish, hide, restore or remove a buyer review, or dismiss its reports (reviews); all but
    // the dismissal are behind a two-step code.
    'reviews/admin/moderation/:id/publish',
    'reviews/admin/moderation/:id/hide',
    'reviews/admin/moderation/:id/restore',
    'reviews/admin/moderation/:id/remove',
    'reviews/admin/moderation/:id/dismiss-reports',
  ],
  PUT: [
    'identity/admin/roles/:id',
    'sellers/admin/:id/review/manual-register-check',
    // The delivery methods the seller supports (shipping), set from the seller review page.
    'shipping/admin/sellers/:id/delivery-methods',
    // A fleet-selection model edited by its id (shipping).
    'shipping/admin/fleet-selection/models/:id',
    // The seller's own commission rate (commission-payouts), set from the seller review page.
    'commission-payouts/admin/sellers/:id/commission-rate',
    // The seller's own payout terms (commission-payouts), behind a two-step code.
    'commission-payouts/admin/sellers/:id/payout-terms',
    // A storefront slide's whole draft (storefront).
    'storefront/admin/slides/:id',
    // The whole content of a brand, with the version seen (catalog).
    'catalog/admin/brands/:id',
    // The whole content of a business activity, with the version seen (catalog).
    'catalog/admin/business-activities/:id',
    // A saved view's name and who can use it (catalog).
    'catalog/admin/saved-filters/:id',
  ],
  DELETE: [
    'identity/admin/roles/:id',
    'commission-payouts/admin/sellers/:id/commission-rate',
    // Back to the Market's payout terms; the version and reason code are in the query.
    'commission-payouts/admin/sellers/:id/payout-terms',
    // Cancel a pending buyer deletion request (customers), behind a two-step code.
    'customers/admin/deletion-requests/:id',
    // A saved view of the product list (catalog).
    'catalog/admin/saved-filters/:id',
  ],
  // The seller's commission rate and ledger, read from the seller review page.
  GET: [
    // The primary photo of a listed product, thumbnail size only (catalog).
    'catalog/admin/products/:id/images/:id/thumb',
    // One import and its report CSV (catalog): the report takes the query `kind`.
    'catalog/admin/platform-imports/:id',
    'catalog/admin/platform-imports/:id/report',
    // One business activity (catalog), read again after a conflict.
    'catalog/admin/business-activities/:id',
    'commission-payouts/admin/sellers/:id/commission-rate',
    'commission-payouts/admin/sellers/:id/ledger',
    // A storefront slide as a package to create in another Market (storefront).
    'storefront/admin/slides/:id/copy',
    // One customer's wallet and the caller's credit caps (wallet), for the issue screen.
    'wallet/admin/customers/:id',
    // One dispute case, read again after a decision (commission-payouts).
    'commission-payouts/admin/disputes/:id',
    // One buyer review for the moderator dialog (reviews).
    'reviews/admin/moderation/:id',
    // One seller payout (commission-payouts), read by the approve dialog.
    'commission-payouts/admin/payouts/:id',
    // A seller's payout terms and holds (commission-payouts), read again after a change.
    'commission-payouts/admin/sellers/:id/payout-terms',
    'commission-payouts/admin/sellers/:id/payout-holds',
    // The delivery methods of a seller (shipping), read again after a conflict.
    'shipping/admin/sellers/:id/delivery-methods',
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
  'storefront/admin/slides/order': ['position', 'scope', 'scopeId'],
  'wallet/admin/credit-requests': ['status', 'cursor', 'limit'],
  'commission-payouts/admin/disputes': ['filter', 'cursor', 'limit'],
  'reviews/admin/moderation': ['tab', 'cursor', 'limit'],
  'catalog/admin/products': [
    'view',
    'q',
    'scope',
    'status',
    'categoryId',
    'typeCode',
    'sellerId',
    'sort',
    'direction',
    'page',
    'pageSize',
  ],
  'catalog/admin/saved-filters': ['listKey'],
  'catalog/admin/products/export': [
    'format',
    'columns',
    'ids',
    'view',
    'q',
    'scope',
    'status',
    'categoryId',
    'typeCode',
    'sellerId',
  ],
  'commission-payouts/admin/payouts': ['status', 'cursor', 'limit'],
  'customers/admin/deletion-requests': ['cursor', 'limit'],
  'catalog/admin/brands': ['status', 'search', 'afterId', 'limit'],
  'catalog/admin/business-activities': ['status', 'search', 'afterId', 'limit'],
};
/** Query values that must have a shape to cross; a value of another shape is dropped. */
const QUERY_SHAPES: Readonly<Record<string, Readonly<Record<string, RegExp>>>> = {
  // The cursor is the API's own: epoch milliseconds, a dot and a request id.
  'wallet/admin/credit-requests': {
    status: /^(pending|decided|granted)$/,
    limit: /^[0-9]{1,3}$/,
    cursor: /^[0-9]{1,15}\.[0-9a-f-]{36}$/,
  },
  'reviews/admin/moderation': {
    tab: /^(held|reported|actioned)$/,
    limit: /^[0-9]{1,3}$/,
    // The API's own cursor: epoch milliseconds of the submission, an underscore and the review id.
    cursor: /^[0-9]{1,15}_[0-9a-f-]{36}$/,
  },
  'commission-payouts/admin/disputes': {
    filter: /^(needs-response|decision-needed|under-review|won|closed)$/,
    limit: /^[0-9]{1,3}$/,
    // The API's own cursor: epoch milliseconds of the opening, a dot and the dispute id.
    cursor: /^[0-9]{1,15}\.[0-9a-f-]{36}$/,
  },
  'catalog/admin/products': {
    view: /^(active|all|inactive)$/,
    scope: /^(PLATFORM|SELLER)$/,
    status: /^(published|paused|unpublished|withdrawn|retired|matched)$/,
    categoryId: UUID,
    typeCode: /^[a-z0-9][a-z0-9_-]{0,63}$/,
    sellerId: UUID,
    sort: /^(name|updated|created)$/,
    direction: /^(asc|desc)$/,
    page: /^[1-9][0-9]{0,3}$/,
    pageSize: /^([1-9][0-9]?|100)$/,
  },
  'catalog/admin/products/export': {
    format: /^(csv|xlsx)$/,
    columns:
      /^(code|offers|updated|type|scope|seller|created)(,(code|offers|updated|type|scope|seller|created)){0,6}$/,
    // At most 200 product ids, the cap of the bulk action.
    ids: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){0,199}$/i,
    view: /^(active|all|inactive)$/,
    scope: /^(PLATFORM|SELLER)$/,
    status: /^(published|paused|unpublished|withdrawn|retired|matched)$/,
    categoryId: UUID,
    typeCode: /^[a-z0-9][a-z0-9_-]{0,63}$/,
    sellerId: UUID,
  },
  'catalog/admin/saved-filters': { listKey: /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/ },
  'commission-payouts/admin/payouts': {
    status: /^(awaiting-approval|approved|instructing|instructed|paid|failed|not-sent)$/,
    limit: /^[0-9]{1,3}$/,
    // The API's own cursor: epoch milliseconds of the creation, a dot and the payout id.
    cursor: /^[0-9]{1,15}\.[0-9a-f-]{36}$/,
  },
  'customers/admin/deletion-requests': {
    limit: /^[0-9]{1,3}$/,
    // The API's own cursor: epoch milliseconds of the scheduled date, a dot and the request id.
    cursor: /^[0-9]{1,15}\.[0-9a-f-]{36}$/,
  },
  'catalog/admin/brands': {
    status: /^(draft|active|archived)$/,
    limit: /^[0-9]{1,3}$/,
    afterId: UUID,
  },
  'catalog/admin/business-activities': {
    status: /^(active|inactive)$/,
    limit: /^[0-9]{1,3}$/,
    afterId: UUID,
  },
  'notifications/admin/notices': { show: /^(unread|read|all)$/, before: UUID },
  'storefront/admin/slides': {
    state: /^(draft|pending|scheduled|live|ended|paused|archived)$/,
    position: /^[a-z]+(?:\.[a-z-]+)+$/,
  },
  'storefront/admin/slides/order': {
    position: /^[a-z]+(?:\.[a-z-]+)+$/,
    scope: /^(all|category|product|seller|page)$/,
    scopeId: UUID,
  },
};
/** GET templates with a resource id whose query crosses, and the keys that may cross. */
const QUERY_KEYS_WITH_ID: Readonly<Record<string, readonly string[]>> = {
  'commission-payouts/admin/sellers/:id/ledger': ['limit', 'cursor'],
  'catalog/admin/platform-imports/:id/report': ['kind'],
};
/** DELETE templates whose query crosses: the version seen and the closed reason code. */
const DELETE_QUERY_KEYS_WITH_ID: Readonly<Record<string, Readonly<Record<string, RegExp>>>> = {
  'commission-payouts/admin/sellers/:id/payout-terms': {
    expectedVersion: /^[0-9]{1,9}$/,
    reasonCode: /^(seller-request|risk-review|correction|policy)$/,
  },
};
const QUERY_VALUE_MAX = 512;
/** A longer value for a key that carries a list: 200 ids of 36 characters and 199 commas. */
const QUERY_VALUE_MAX_FOR: Readonly<Record<string, number>> = {
  'catalog/admin/products/export:ids': 7400,
};

/** The allowed keys of the request's query, capped in length; everything else is dropped. */
function upstreamQuery(method: string, target: string, requestUrl: string): string {
  // The relay allows an id segment only when it is a UUID, so the template is the path with
  // each UUID segment named `:id`.
  const template = target
    .split('/')
    .map((part) => (UUID.test(part) ? ':id' : part))
    .join('/');
  const deleteKeys = method === 'DELETE' ? DELETE_QUERY_KEYS_WITH_ID[template] : undefined;
  const keys =
    method === 'GET'
      ? (QUERY_KEYS[target] ?? QUERY_KEYS_WITH_ID[template])
      : deleteKeys === undefined
        ? undefined
        : Object.keys(deleteKeys);
  if (keys === undefined) return '';
  const source = new URL(requestUrl).searchParams;
  const shapes = deleteKeys ?? QUERY_SHAPES[target];
  const kept = new URLSearchParams();
  for (const key of keys) {
    const value = source.get(key);
    if (
      value === null ||
      value.length > (QUERY_VALUE_MAX_FOR[`${target}:${key}`] ?? QUERY_VALUE_MAX)
    ) {
      continue;
    }
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
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'retry-after',
  // The product export (CSV or XLSX) and the import report CSV arrive as attachments with a file name the API made.
  'content-disposition',
] as const;

/** The API issues the correlation id and returns it in this header (ADR-0034 decision 3). */
const CORRELATION_HEADER = 'x-correlation-id';

/** One structured line per failed relay: ids and codes only, never a body, cookie or token. */
export type RelayLog = (line: Record<string, string | number>) => void;
const stdoutLog: RelayLog = (line) => console.log(JSON.stringify(line));

const MAX_BODY_BYTES = 16 * 1024;
/**
 * The import upload carries a file of at most 10 MiB as base64 (about 14 MB). The API accepts
 * 14500 kB for this one path and checks the real size itself; every other path keeps 16 KB.
 */
const UPLOAD_PATH = 'catalog/admin/platform-imports';
const MAX_UPLOAD_BODY_BYTES = 14_500 * 1024;

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

/**
 * Set on every answer of the relay itself. The panel's `proxy.ts` does not run for `/api/` (its
 * body buffer would cut a large upload), so the one header a file download needs, `nosniff`, is
 * set here: a CSV or workbook from the API is never read as another type.
 */
const withSafetyHeaders = (headers: Record<string, string>): Record<string, string> => ({
  ...headers,
  'x-content-type-options': 'nosniff',
});

const jsonError = (status: number, code: string): Response =>
  new Response(JSON.stringify({ statusCode: status, code }), {
    status,
    headers: withSafetyHeaders({
      'content-type': 'application/json',
      'cache-control': 'no-store',
    }),
  });

const notFound = (): Response =>
  new Response(null, {
    status: 404,
    headers: withSafetyHeaders({ 'cache-control': 'no-store' }),
  });

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
  const bodyCap =
    request.method === 'POST' && target === UPLOAD_PATH ? MAX_UPLOAD_BODY_BYTES : MAX_BODY_BYTES;
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > bodyCap) return jsonError(413, 'request.too-large');
  let body: string | undefined;
  if (request.method !== 'GET') {
    // Read the stream with a hard cap, so a chunked body without Content-Length is refused too.
    const read = await readCapped(request, bodyCap);
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
  headers.set('x-content-type-options', 'nosniff');
  for (const cookie of upstream.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(upstream.status === 204 ? null : await upstream.arrayBuffer(), {
    status: upstream.status,
    headers,
  });
}
