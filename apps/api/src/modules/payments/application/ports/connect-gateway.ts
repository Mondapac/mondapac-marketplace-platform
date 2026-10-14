import type { Result } from '@mondapac/shared-kernel';
import type { AccountSnapshot } from '../../domain/connected-account';

export type ConnectFailure =
  /** Stripe could not be reached or answered with an error: try again later. */
  | { readonly code: 'payment.provider-unavailable' }
  /** Stripe refused the request: do not repeat it unchanged. */
  | { readonly code: 'payment.provider-rejected' };

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
}

export const CONNECT_GATEWAY = Symbol('CONNECT_GATEWAY');
