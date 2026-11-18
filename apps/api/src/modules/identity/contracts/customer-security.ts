import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { DeviceCode } from '../domain/device';

// The shapes of a customer's security section on the admin customer page (customers management
// phase 2b), as identity's facade answers them: the sign-ins of the last 90 days, the live
// sessions and the refusals. Ids, codes and instants only; never an address, a session id or a
// token. The use cases behind the facade live in application/accounts/customer-security.ts.

/** How a customer's sign-in record reads on the customer page: a success, a failure, or a credential change. */
export const CUSTOMER_SIGN_IN_RESULTS = ['success', 'failure', 'credential-change'] as const;
export type CustomerSignInResult = (typeof CUSTOMER_SIGN_IN_RESULTS)[number];

export type CustomerSecurityFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'account.unknown' };

export interface CustomerSignInsRequest {
  readonly accountId: Id<'Account'>;
  readonly results: readonly CustomerSignInResult[] | null;
  /** Clamped to the last 90 days. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
  readonly direction: 'asc' | 'desc';
  readonly window: { readonly offset: number; readonly limit: number };
  /** Count every match (page-number mode); false in Previous and Next mode and for an export. */
  readonly withTotal: boolean;
}

/** One sign-in as the customer page shows it: no address, no session id, no correlation id. */
export interface CustomerSignInFact {
  readonly signInId: Id<'SignInRecord'>;
  readonly occurredAt: string;
  /** The outcome code of identity design 6.3 (`signed-in`, `password.incorrect`, ...). */
  readonly outcome: string;
  readonly result: CustomerSignInResult;
  /** `<browser>.<system>`; null when unknown (older records, no User-Agent). */
  readonly device: DeviceCode | null;
  /**
   * Where the sign-in came from as a rough place. Always null for now: no geo lookup exists and
   * the owner has not decided to show one (the default is no city). A future lookup fills it
   * here, from the address, without the address leaving identity.
   */
  readonly city: null;
}

export interface CustomerSignInsPage {
  readonly rows: readonly CustomerSignInFact[];
  readonly total: number | null;
  /** The oldest instant the page can show (now minus 90 days), for the panel's note. */
  readonly since: string;
}

/** One live session of the customer: the coarse device and two instants. No id, token or address. */
export interface CustomerSessionFact {
  readonly device: DeviceCode | null;
  readonly signedInAt: string;
  readonly lastActiveAt: string;
}

export interface CustomerSessionsView {
  readonly items: readonly CustomerSessionFact[];
  /** True when the account has more live sessions than the list shows. */
  readonly more: boolean;
}

export type AdminPasswordResetFailure =
  | CustomerSecurityFailure
  /** A disabled account, or one whose email is not verified: no mail goes (as "Forgot password?"). */
  | { readonly code: 'account.not-eligible' }
  /** A reset was requested less than five minutes ago. */
  | { readonly code: 'password-reset.recently-requested' };
