import type { Result } from '@mondapac/shared-kernel';
import type { AccountSnapshot } from '../../domain/connected-account';

export type ConnectFailure =
  /** Stripe could not be reached or answered with an error: try again later. */
  | {
      readonly code: 'payment.provider-unavailable';
      /** True when Stripe answered with an error status (not a timeout or a lost connection). */
      readonly answered?: boolean;
    }
  /** Stripe refused the request: do not repeat it unchanged. */
  | { readonly code: 'payment.provider-rejected' };

/** The payout schedules payments sets: `manual` pauses payouts, the other is the Market's own. */
export type NormalPayoutSchedule = 'daily';
export type PayoutSchedule = 'manual' | NormalPayoutSchedule;

/** What payments asks Stripe about connected accounts. Test mode only. */
export interface ConnectGateway {
  /**
   * Creates an Express account with the `transfers` capability. The key makes a repeated call
   * return the same account; it is stored before the call and never replaced.
   */
  createAccount(request: {
    readonly idempotencyKey: string;
    readonly country: string;
    readonly marketId: string;
    readonly sellerId: string;
  }): Promise<Result<{ readonly accountRef: string }, ConnectFailure>>;

  /** A one-time hosted onboarding (or update) page; the URL is returned, never stored. */
  createAccountLink(request: {
    readonly accountRef: string;
    readonly kind: 'onboarding' | 'update';
    readonly returnUrl: string;
    readonly refreshUrl: string;
  }): Promise<Result<{ readonly url: string }, ConnectFailure>>;

  /** The account as Stripe reports it now. */
  readAccount(accountRef: string): Promise<Result<AccountSnapshot, ConnectFailure>>;

  /**
   * Sets the account's payout schedule (`manual` pauses Stripe payouts). The key makes a repeated
   * call a no-op; only the `payments.sync-payout-schedules` job calls it.
   */
  setPayoutSchedule(
    accountRef: string,
    schedule: PayoutSchedule,
    idempotencyKey: string,
  ): Promise<Result<void, ConnectFailure>>;
}

export const CONNECT_GATEWAY = Symbol('CONNECT_GATEWAY');
