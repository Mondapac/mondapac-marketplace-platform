// The customer page's Account & security tab (customers management phase 2b, part B): the keys
// each section needs and the answers it reads. Every section reads from its owner by account id.

export const VIEW_KEY = 'customers.customers.view';
export const SIGN_IN_VIEW = 'identity.customer-sign-in.view';
export const SIGN_IN_REVEAL = 'identity.customer-sign-in.reveal';
export const SESSION_END = 'identity.customer-session.end';
export const PASSWORD_RESET_SEND = 'identity.customer-password-reset.send';
export const ADDRESS_REVEAL = 'customers.customer-address.reveal';
export const CONSENT_VIEW = 'legal.customer-consent.view';
export const BEHAVIOUR_VIEW = 'engagement.customer-behaviour.view';

/** A revealed address or IP is hidden again after five minutes (the reveal rule, spec section 4). */
export const REVEAL_MS = 5 * 60 * 1000;

export const SIGN_IN_RESULTS = ['success', 'failure', 'credential-change'] as const;
export type SignInResult = (typeof SIGN_IN_RESULTS)[number];

/** One page of a section's super list, as every section list answers it. */
export interface SectionPage<R> {
  readonly items: readonly R[];
  readonly page: number;
  readonly pageSize: number;
  readonly paging: 'pages' | 'prev-next';
  /** Rows over all pages; null in `prev-next` mode (never counted). */
  readonly total: number | null;
  readonly hasNext: boolean;
}

export interface SignIn {
  readonly signInId: string;
  readonly occurredAt: string;
  readonly outcome: string;
  readonly result: string;
  /** `<browser>.<system>`, or null when unknown. */
  readonly device: string | null;
  /** Always null until the owner decides on a geo lookup. */
  readonly city: string | null;
}
export interface SignInsPage extends SectionPage<SignIn> {
  /** The oldest instant the list reaches (90 days back). */
  readonly since?: string;
}
export interface SignInReveal {
  readonly signInId: string;
  readonly address: string;
  readonly occurredAt: string;
}

export interface Session {
  readonly device: string | null;
  readonly signedInAt: string;
  readonly lastActiveAt: string;
}
export interface SessionsView {
  readonly items: readonly Session[];
  readonly more: boolean;
}

export interface AddressSummary {
  readonly addressId: string;
  /** Null once the customer's key is destroyed (the account is being erased). */
  readonly suburb: string | null;
  readonly countryCode: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
}
export interface AddressFull {
  readonly addressId: string;
  readonly countryCode: string;
  readonly recipientFirstName: string;
  readonly recipientLastName: string;
  readonly phone: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly suburb: string;
  readonly region: string | null;
  readonly postcode: string;
  readonly deliveryNotes: string | null;
}

export interface ConsentState {
  readonly channel: string;
  readonly granted: boolean;
  readonly source: string | null;
  readonly changedAt: string | null;
}
export interface ConsentView {
  readonly channels: readonly ConsentState[];
}
export interface ConsentChange {
  readonly channel: string;
  readonly granted: boolean;
  readonly source: string;
  readonly occurredAt: string;
}
export interface PersonalizationView {
  readonly personalization: { readonly enabled: boolean; readonly changedAt: string | null };
}

/** `chrome.windows` as two words; null when unknown. No browser or system is named in code. */
export function deviceParts(code: string | null): { browser: string; system: string } | null {
  if (code === null) return null;
  const [browser, system] = code.split('.');
  if (browser === undefined || browser === '') return null;
  const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  return { browser: title(browser), system: system === undefined ? '' : title(system) };
}

/** A region name for a country code in the admin's language; the code itself when unknown. */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}
