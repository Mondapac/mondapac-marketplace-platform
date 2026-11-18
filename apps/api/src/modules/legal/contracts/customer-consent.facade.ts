import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** One channel's current marketing consent; `source` and `changedAt` null when never set. */
export interface AdminConsentState {
  readonly channel: string;
  /** Express opt-in: false until the customer agreed. */
  readonly granted: boolean;
  readonly source: string | null;
  /** ISO instant. */
  readonly changedAt: string | null;
}

/** One change of a marketing consent, as kept for the proof of consent. */
export interface AdminConsentChange {
  readonly channel: string;
  readonly granted: boolean;
  readonly source: string;
  /** ISO instant. */
  readonly occurredAt: string;
}

export interface AdminConsentHistoryRequest {
  readonly accountId: Id<'Account'>;
  /** Only the changes of these channels; null for all. */
  readonly channels: readonly string[] | null;
  readonly direction: 'asc' | 'desc';
  readonly window: { readonly offset: number; readonly limit: number };
  readonly withTotal: boolean;
}

export type CustomerConsentFailure = AccessDenied | { readonly code: 'access.unavailable' };

/**
 * The admin's reads of one customer's marketing consent (customers management phase 2b), behind
 * `legal.customer-consent.view`, for a platform admin not acting as anyone. Read only; the
 * caller's `CallContext` is passed unchanged.
 */
export interface CustomerConsentFacade {
  adminCustomerConsent(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly channels: readonly AdminConsentState[] }, CustomerConsentFailure>>;

  adminCustomerConsentHistory(
    context: CallContext,
    request: AdminConsentHistoryRequest,
  ): Promise<
    Result<
      { readonly rows: readonly AdminConsentChange[]; readonly total: number | null },
      CustomerConsentFailure
    >
  >;
}

export const CUSTOMER_CONSENT_FACADE = Symbol('CUSTOMER_CONSENT_FACADE');
