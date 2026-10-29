import type { Palette, TextSize } from '../preferences/preferences.ts';
import type {
  CheckoutCustomer,
  DeliveryMethod,
  MethodOption,
  MethodPrice,
  MethodReason,
  Money,
  SavedAddress,
  SellerDeliveryOptions,
} from '../storefront/types.ts';

// The buyer's own API calls, made from the browser through the same-origin relay (`/api/...`,
// src/storefront/session-relay.ts). Only used in live mode. Bodies, passwords and tokens are never logged.

/** A refused field: its path in the body and a code, never the value. */
export interface FieldProblem {
  readonly path: string;
  readonly code: string;
}

/** How a call ended; every call maps the API's answer to one of these. */
export type ApiResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  /** The API refused the request (400, 403, 404, 409, 422): its error `code`, the fields and details. */
  | {
      readonly kind: 'invalid';
      readonly code: string;
      readonly fields: readonly FieldProblem[];
      readonly details: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'throttled'; readonly retryAfterSeconds: number | undefined }
  /** 401: no session (for sign-in, `code` is `credentials.invalid`). */
  | { readonly kind: 'signed-out'; readonly code: string }
  | { readonly kind: 'failed' };

export interface SessionView {
  readonly email: string;
  readonly displayName: string | null;
  readonly appearance: {
    readonly palette: Palette | null;
    readonly textSize: TextSize | null;
  } | null;
}

/** The name the shop shows: the display name, else the part of the email before the "@". */
export function shownName(session: Pick<SessionView, 'email' | 'displayName'>): string {
  const name = session.displayName?.trim();
  return name ? name : (session.email.split('@')[0] ?? session.email);
}

/** The signed-in customer of the store from a session and the address book. */
export function customerOf(
  session: SessionView,
  addresses: readonly SavedAddress[],
): CheckoutCustomer {
  const fullName = shownName(session);
  return {
    firstName: fullName.split(/\s+/)[0] ?? fullName,
    fullName,
    email: session.email,
    addresses,
  };
}

/** The address fields the API takes (the region comes from the service area). */
export interface AddressInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly street: string;
  readonly line2: string | null;
  readonly suburb: string;
  readonly region: string;
  readonly postcode: string;
  readonly deliveryNotes: string | null;
  readonly isDefault?: boolean;
}

// The session's CSRF token, kept in this tab. The API gives a new one at sign-in and when the
// password changes.
let csrfToken: string | null = null;

/** Forgets the token (sign-out; tests). */
export function forgetCsrfToken(): void {
  csrfToken = null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: object | undefined,
  read: (json: Record<string, unknown>) => T | undefined,
  guest = false,
): Promise<ApiResult<T>> {
  const result = await callOnce(method, path, body, read, guest);
  // A token from before the session rotated (a password change in another tab): read the
  // session's current token and try once more.
  if (result.kind === 'invalid' && result.code === 'request.csrf' && method !== 'GET') {
    forgetCsrfToken();
    return callOnce(method, path, body, read, guest);
  }
  return result;
}

/**
 * One request. `guest`: the route also serves a buyer without a session (the cart), so a write
 * with no session goes without a token; the API then uses the guest-cart cookie.
 */
async function callOnce<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: object | undefined,
  read: (json: Record<string, unknown>) => T | undefined,
  guest: boolean,
): Promise<ApiResult<T>> {
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    // Sign-in starts the session, so it has no token to send.
    if (method !== 'GET' && path !== 'identity/customer/sign-in') {
      if (csrfToken === null) {
        // No token yet (a page opened with a session from before): read the session for it.
        const session = await readSession();
        if (session.kind !== 'ok' && !(guest && session.kind === 'signed-out')) return session;
      }
      if (csrfToken !== null) headers['x-csrf-token'] = csrfToken;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`/api/${path}`, {
      method,
      credentials: 'same-origin',
      headers,
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json: unknown = await response.json().catch(() => ({}));
    const answer = isRecord(json) ? json : {};
    if (response.ok) {
      const value = read(answer);
      return value === undefined ? { kind: 'failed' } : { kind: 'ok', value };
    }
    const code = typeof answer.code === 'string' ? answer.code : '';
    const details = isRecord(answer.details) ? answer.details : {};
    if (response.status === 401) return { kind: 'signed-out', code };
    if (response.status === 429) {
      const after = details.retryAfterSeconds;
      return {
        kind: 'throttled',
        retryAfterSeconds: typeof after === 'number' ? after : undefined,
      };
    }
    if ([400, 403, 404, 409, 422].includes(response.status)) {
      const fields = Array.isArray(details.fields)
        ? details.fields.flatMap((f: unknown) =>
            isRecord(f) && typeof f.path === 'string' && typeof f.code === 'string'
              ? [{ path: f.path, code: f.code }]
              : [],
          )
        : [];
      return { kind: 'invalid', code, fields, details };
    }
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const orNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function takeToken(json: Record<string, unknown>): void {
  const token = text(json.csrfToken);
  if (token !== undefined) csrfToken = token;
}

const PALETTES: readonly string[] = ['A', 'B', 'C', 'D'];
const TEXT_SIZES: readonly string[] = ['auto', 'large', 'small'];

/** `GET identity/customer/session`: who is signed in; also keeps the session's CSRF token. */
export function readSession(): Promise<ApiResult<SessionView>> {
  return call('GET', 'identity/customer/session', undefined, (json) => {
    const email = text(json.email);
    if (email === undefined) return undefined;
    takeToken(json);
    const look = isRecord(json.appearance) ? json.appearance : null;
    return {
      email,
      displayName: orNull(json.displayName),
      appearance: look
        ? {
            palette: PALETTES.includes(String(look.palette)) ? (look.palette as Palette) : null,
            textSize: TEXT_SIZES.includes(String(look.textSize))
              ? (look.textSize as TextSize)
              : null,
          }
        : null,
    };
  });
}

export function signIn(email: string, password: string): Promise<ApiResult<true>> {
  return call('POST', 'identity/customer/sign-in', { email, password }, (json) => {
    takeToken(json);
    return true as const;
  });
}

export async function signOut(): Promise<ApiResult<true>> {
  const result = await call('POST', 'identity/customer/sign-out', undefined, () => true as const);
  forgetCsrfToken();
  return result;
}

export function saveDisplayName(displayName: string): Promise<ApiResult<true>> {
  return call(
    'PUT',
    'identity/customer/profile/display-name',
    { displayName },
    () => true as const,
  );
}

export function saveAppearance(look: {
  readonly palette: Palette | null;
  readonly textSize: TextSize | null;
}): Promise<ApiResult<true>> {
  return call('PUT', 'identity/customer/profile/appearance', look, () => true as const);
}

/** Changes the password; the API answers with the session's new CSRF token, which is kept. */
export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<ApiResult<true>> {
  return call(
    'POST',
    'identity/customer/change-password',
    { currentPassword, newPassword },
    (json) => {
      takeToken(json);
      return true as const;
    },
  );
}

function addressOf(json: unknown): SavedAddress | undefined {
  if (!isRecord(json)) return undefined;
  const id = text(json.id);
  const firstName = text(json.recipientFirstName);
  const lastName = text(json.recipientLastName);
  const street = text(json.line1);
  const suburb = text(json.suburb);
  const postcode = text(json.postcode);
  const phone = text(json.phone);
  if (
    id === undefined ||
    firstName === undefined ||
    lastName === undefined ||
    street === undefined ||
    suburb === undefined ||
    postcode === undefined ||
    phone === undefined
  )
    return undefined;
  return {
    id,
    firstName,
    lastName,
    street,
    line2: orNull(json.line2),
    suburb,
    postcode,
    phone,
    deliveryNotes: orNull(json.deliveryNotes),
    isDefault: json.isDefault === true,
  };
}

function bookOf(json: Record<string, unknown>): readonly SavedAddress[] | undefined {
  if (!Array.isArray(json.addresses)) return undefined;
  const book = json.addresses.map(addressOf);
  return book.every((a): a is SavedAddress => a !== undefined) ? book : undefined;
}

function addressBody(input: AddressInput): Record<string, unknown> {
  return {
    recipientFirstName: input.firstName,
    recipientLastName: input.lastName,
    phone: input.phone,
    line1: input.street,
    ...(input.line2 === null ? {} : { line2: input.line2 }),
    suburb: input.suburb,
    region: input.region,
    postcode: input.postcode,
    ...(input.deliveryNotes === null ? {} : { deliveryNotes: input.deliveryNotes }),
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
  };
}

export function listAddresses(): Promise<ApiResult<readonly SavedAddress[]>> {
  return call('GET', 'customers/me/addresses', undefined, bookOf);
}

export function createAddress(input: AddressInput): Promise<ApiResult<SavedAddress>> {
  return call('POST', 'customers/me/addresses', addressBody(input), addressOf);
}

export function updateAddress(id: string, input: AddressInput): Promise<ApiResult<SavedAddress>> {
  return call('PUT', `customers/me/addresses/${id}`, addressBody(input), addressOf);
}

export function deleteAddress(id: string): Promise<ApiResult<true>> {
  return call('DELETE', `customers/me/addresses/${id}`, undefined, () => true as const);
}

/** Makes an address the default; answers the whole book. */
export function makeDefaultAddress(id: string): Promise<ApiResult<readonly SavedAddress[]>> {
  return call('POST', `customers/me/addresses/${id}/default`, undefined, bookOf);
}

// The delivery options of the basket for a saved address (`POST orders/delivery-quotes`). The
// server asks the couriers and stores each quote; the browser only shows the answer and sends the
// quote id back at checkout. A saved address is the only stop that is ever quoted.

const METHODS: readonly DeliveryMethod[] = ['pickup', 'instant', 'same_day', 'scheduled'];
const REASONS: readonly MethodReason[] = [
  'seller-unsupported',
  'past-cut-off',
  'no-pickup-address',
];
const DIGITS = /^[0-9]{1,15}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/u;

function moneyOf(json: unknown): Money | undefined {
  if (!isRecord(json)) return undefined;
  const { amount, currency } = json;
  if (typeof amount !== 'string' || !DIGITS.test(amount)) return undefined;
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) return undefined;
  return { amount: Number(amount), currency };
}

function priceOf(json: unknown): MethodPrice | null | undefined {
  if (json === null) return null;
  if (!isRecord(json)) return undefined;
  const { state } = json;
  if (state === 'free' || state === 'no-fleet' || state === 'failed') return { state };
  if (state !== 'quoted') return undefined;
  const total = moneyOf(json.total);
  const tax = moneyOf(json.tax);
  const quoteId = text(json.quoteId);
  const validUntil = text(json.validUntil);
  const eta = json.etaMinutes;
  if (total === undefined || tax === undefined || quoteId === undefined) return undefined;
  if (validUntil === undefined || Number.isNaN(Date.parse(validUntil))) return undefined;
  if (eta !== null && eta !== undefined && !Number.isSafeInteger(eta)) return undefined;
  return {
    state,
    quoteId,
    total,
    tax,
    etaMinutes: typeof eta === 'number' ? eta : null,
    validUntil,
  };
}

function optionOf(json: unknown): MethodOption | undefined {
  if (!isRecord(json)) return undefined;
  const method = METHODS.find((m) => m === json.method);
  const price = priceOf(json.price);
  if (method === undefined || typeof json.available !== 'boolean' || price === undefined)
    return undefined;
  const reason = json.reason === null ? null : REASONS.find((r) => r === json.reason);
  if (reason === undefined) return undefined;
  return { method, available: json.available, reason, price };
}

function optionsOf(
  json: Record<string, unknown>,
): Record<string, SellerDeliveryOptions> | undefined {
  if (!Array.isArray(json.sellers)) return undefined;
  const found: Record<string, SellerDeliveryOptions> = Object.create(null) as Record<
    string,
    SellerDeliveryOptions
  >;
  for (const seller of json.sellers as unknown[]) {
    if (!isRecord(seller)) return undefined;
    const id = text(seller.sellerId);
    const zone = text(seller.zone);
    const cutoff = text(seller.sameDayCutoff);
    const days = seller.scheduledDaysAhead;
    const minutes = seller.scheduledWindowMinutes;
    const pickup = seller.pickupPostcode;
    if (
      id === undefined ||
      zone === undefined ||
      cutoff === undefined ||
      !CLOCK.test(cutoff) ||
      typeof days !== 'number' ||
      !Number.isSafeInteger(days) ||
      typeof minutes !== 'number' ||
      !Number.isSafeInteger(minutes) ||
      minutes <= 0 ||
      !(pickup === null || typeof pickup === 'string') ||
      !Array.isArray(seller.methods)
    )
      return undefined;
    const methods = (seller.methods as unknown[]).map(optionOf);
    if (!methods.every((m): m is MethodOption => m !== undefined)) return undefined;
    found[id] = {
      zone,
      sameDayCutoff: cutoff,
      scheduledDaysAhead: days,
      scheduledWindowMinutes: minutes,
      pickupPostcode: pickup,
      methods,
    };
  }
  return found;
}

/** `POST orders/delivery-quotes`: every seller's methods and prices for a saved address. */
export function readDeliveryOptions(
  addressId: string,
): Promise<ApiResult<Readonly<Record<string, SellerDeliveryOptions>>>> {
  return call('POST', 'orders/delivery-quotes', { addressId }, optionsOf);
}

// The cart (guest or account) and the account's saved list. The bodies are mapped by
// src/cart/live-cart.ts; here they are passed on as they came.

const body = (json: Record<string, unknown>): Record<string, unknown> => json;

/** `GET cart`: the buyer's cart, the account's or this browser's guest cart. */
export function readCart(): Promise<ApiResult<Record<string, unknown>>> {
  return call('GET', 'cart', undefined, body, true);
}

/** `POST cart/items`: adds units of a sell unit (to its line when there is one). */
export function addCartItem(
  offerId: string,
  variantId: string,
  quantity: number,
): Promise<ApiResult<true>> {
  return call('POST', 'cart/items', { offerId, variantId, quantity }, () => true as const, true);
}

/** `PUT cart/items/:lineId`: sets a line's quantity (1 or more). */
export function setCartLineQuantity(lineId: string, quantity: number): Promise<ApiResult<true>> {
  return call('PUT', `cart/items/${lineId}`, { quantity }, () => true as const, true);
}

/** `DELETE cart/items/:lineId`. */
export function removeCartLine(lineId: string): Promise<ApiResult<true>> {
  return call('DELETE', `cart/items/${lineId}`, undefined, () => true as const, true);
}

/** `GET cart/saved`: the signed-in customer's saved list. */
export function readSaved(): Promise<ApiResult<Record<string, unknown>>> {
  return call('GET', 'cart/saved', undefined, body);
}

/** `POST cart/saved`: moves a line of the account's cart to the saved list. */
export function saveCartLine(lineId: string): Promise<ApiResult<true>> {
  return call('POST', 'cart/saved', { lineId }, () => true as const);
}

/** `POST cart/saved/:savedId/move-to-cart`: one of the saved item goes back to the cart. */
export function moveSavedToCart(savedId: string): Promise<ApiResult<true>> {
  return call('POST', `cart/saved/${savedId}/move-to-cart`, undefined, () => true as const);
}

/** `DELETE cart/saved/:savedId`. */
export function removeSavedItem(savedId: string): Promise<ApiResult<true>> {
  return call('DELETE', `cart/saved/${savedId}`, undefined, () => true as const);
}

// Account deletion (customers package 5a and 5b). The buyer site only shows these answers; every
// rule (the setting, the blockers, the waiting period) is the API's.

/** `GET customers/me/account-deletion`: the Market's switch and the wait of a request. */
export interface DeletionAvailability {
  readonly canDeleteAccount: boolean;
  readonly waitingPeriodDays: number;
}

/** The buyer's open deletion request: `pending` can be cancelled, `executing` cannot. */
export interface DeletionRequest {
  readonly status: 'pending' | 'executing';
  /** When the account will be erased (a UTC instant). */
  readonly scheduledFor: string;
  readonly waitingPeriodDays: number;
}

/** What stops a deletion until it is settled; `count` is given for orders and refunds. */
export interface DeletionBlocker {
  readonly code: 'open-orders' | 'pending-refunds' | 'wallet-balance';
  readonly count: number | null;
}

export function readDeletionAvailability(): Promise<ApiResult<DeletionAvailability>> {
  return call('GET', 'customers/me/account-deletion', undefined, (json) => {
    const days = json.waitingPeriodDays;
    if (typeof json.canDeleteAccount !== 'boolean') return undefined;
    if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1) return undefined;
    return { canDeleteAccount: json.canDeleteAccount, waitingPeriodDays: days };
  });
}

function deletionRequestOf(json: Record<string, unknown>): DeletionRequest | undefined {
  const status = json.status;
  const when = text(json.scheduledFor);
  const days = json.waitingPeriodDays;
  if (status !== 'pending' && status !== 'executing') return undefined;
  if (when === undefined || Number.isNaN(Date.parse(when))) return undefined;
  if (typeof days !== 'number' || !Number.isSafeInteger(days)) return undefined;
  return { status, scheduledFor: when, waitingPeriodDays: days };
}

/** `GET customers/me/deletion-requests/current`: 404 (`invalid`) when there is no open request. */
export function readDeletionRequest(): Promise<ApiResult<DeletionRequest>> {
  return call('GET', 'customers/me/deletion-requests/current', undefined, deletionRequestOf);
}

/** `POST customers/me/deletion-requests`: the buyer confirms; the request starts to wait. */
export function requestDeletion(): Promise<ApiResult<DeletionRequest>> {
  return call('POST', 'customers/me/deletion-requests', { confirm: true }, deletionRequestOf);
}

/** `DELETE customers/me/deletion-requests/current`: 204 while the request is still pending. */
export function cancelDeletion(): Promise<ApiResult<true>> {
  return call('DELETE', 'customers/me/deletion-requests/current', undefined, () => true as const);
}

/** The blockers of a 409 `customers.account-deletion-blocked`, in the order the API gave them. */
export function blockersOf(details: Readonly<Record<string, unknown>>): readonly DeletionBlocker[] {
  if (!Array.isArray(details.blockers)) return [];
  return details.blockers.flatMap((item: unknown): DeletionBlocker[] => {
    if (!isRecord(item)) return [];
    const code = item.code;
    if (code !== 'open-orders' && code !== 'pending-refunds' && code !== 'wallet-balance')
      return [];
    const count = item.count;
    return [{ code, count: typeof count === 'number' ? count : null }];
  });
}
