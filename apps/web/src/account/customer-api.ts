import type { Palette, TextSize } from '../preferences/preferences.ts';
import type { CheckoutCustomer, SavedAddress } from '../storefront/types.ts';

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
  /** The API refused the request (400, 403, 404, 422): its error `code`, the fields and details. */
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
): Promise<ApiResult<T>> {
  const result = await callOnce(method, path, body, read);
  // A token from before the session rotated (a password change in another tab): read the
  // session's current token and try once more.
  if (result.kind === 'invalid' && result.code === 'request.csrf' && method !== 'GET') {
    forgetCsrfToken();
    return callOnce(method, path, body, read);
  }
  return result;
}

async function callOnce<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: object | undefined,
  read: (json: Record<string, unknown>) => T | undefined,
): Promise<ApiResult<T>> {
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    // Sign-in starts the session, so it has no token to send.
    if (method !== 'GET' && path !== 'identity/customer/sign-in') {
      if (csrfToken === null) {
        // No token yet (a page opened with a session from before): read the session for it.
        const session = await readSession();
        if (session.kind !== 'ok') return session;
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
    if ([400, 403, 404, 422].includes(response.status)) {
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
