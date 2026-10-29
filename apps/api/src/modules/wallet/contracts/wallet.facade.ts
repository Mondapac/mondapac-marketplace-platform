import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { WalletStatus } from '../domain/wallet-status';

export type WalletFailure =
  | AccessDenied
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** The wallet is `off` in this Market (or has never been switched on). */
  | { readonly code: 'wallet.disabled' }
  /** Wind-down: no new grants and no new holds. */
  | { readonly code: 'wallet.paused' }
  /** Emergency: no grants, no new holds and no capture; release still works. */
  | { readonly code: 'wallet.frozen' }
  /** The Market has no wallet settings or the read failed: callers fail closed. */
  | { readonly code: 'wallet.unavailable' }
  /** The customer's wallet is frozen or closed. */
  | { readonly code: 'wallet.account-not-active' }
  | { readonly code: 'wallet.cap-exceeded' }
  | { readonly code: 'wallet.insufficient-funds' }
  | { readonly code: 'wallet.not-found' }
  /** The order already has a hold under another idempotency key. */
  | { readonly code: 'wallet.hold-exists' }
  /** Capture or release of a hold that is no longer `held`. */
  | { readonly code: 'wallet.hold-not-held' }
  /** Capture of a hold past its expiry; the sweep releases it. */
  | { readonly code: 'wallet.hold-expired' }
  /** The same idempotency key was used for a different request. */
  | { readonly code: 'idempotency.key-reused' };

/** What a customer wallet holds now, in the Market currency. */
export interface WalletBalance {
  readonly available: Money;
  readonly held: Money;
}

export interface GrantCreditRequest {
  readonly customerAccountId: Id<'Account'>;
  /** `promo` expires after the Market's promo months; `refund` never expires. */
  readonly source: 'promo' | 'refund';
  readonly amount: Money;
  /** A closed lower-case code, such as `welcome` or `order-refund`. */
  readonly reasonCode: string;
  readonly orderId?: Id<'Order'>;
  /** Same key and same request: the first result again. Same key, other request: refused. */
  readonly idempotencyKey: string;
}

export interface GrantCreditResult {
  readonly journalId: Id<'WalletJournal'>;
  readonly lotId: Id<'WalletLot'>;
  /** The balance right after the grant. */
  readonly balance: WalletBalance;
}

export interface PlaceHoldRequest {
  readonly customerAccountId: Id<'Account'>;
  readonly orderId: Id<'Order'>;
  readonly amount: Money;
  /** When an unsettled hold is released by the expiry job. */
  readonly expiresAt: Temporal.Instant;
  readonly idempotencyKey: string;
}

export interface HoldResult {
  readonly holdId: Id<'WalletHold'>;
  readonly journalId: Id<'WalletJournal'>;
  readonly amount: Money;
  readonly status: 'held' | 'captured' | 'released' | 'expired';
}

export interface SettleHoldRequest {
  readonly customerAccountId: Id<'Account'>;
  readonly orderId: Id<'Order'>;
  readonly idempotencyKey: string;
}

export interface WalletBalanceView extends WalletBalance {
  /** The wallet state of the Market, so a caller can tell a quiet wallet from a switched-off one. */
  readonly marketStatus: WalletStatus;
}

/**
 * What other modules call (system or internal callers only; there is no ordering wiring yet).
 * Each method takes the caller's `CallContext` unchanged and is not exposed over HTTP. Writes
 * answer `wallet.disabled` while the Market's wallet is off, and are refused in the states the
 * switch names (paused: no grant or hold; frozen: no grant, hold or capture). A hold already
 * placed can always be released.
 */
export interface WalletFacade {
  grantCredit(
    context: CallContext,
    request: GrantCreditRequest,
  ): Promise<Result<GrantCreditResult, WalletFailure>>;

  placeHold(
    context: CallContext,
    request: PlaceHoldRequest,
  ): Promise<Result<HoldResult, WalletFailure>>;

  captureHold(
    context: CallContext,
    request: SettleHoldRequest,
  ): Promise<Result<HoldResult, WalletFailure>>;

  releaseHold(
    context: CallContext,
    request: SettleHoldRequest,
  ): Promise<Result<HoldResult, WalletFailure>>;

  /** A customer's balance. A wallet that was never granted credit holds zero. Reads work in every state. */
  balanceOf(
    context: CallContext,
    customerAccountId: Id<'Account'>,
  ): Promise<Result<WalletBalanceView, WalletFailure>>;

  /**
   * A customer's balance for an admin's deletion request for a buyer (customers package 5c). Rule
   * `own-resources`: a platform admin that is not acting as a seller, any other caller
   * `access.denied`; the calling use case holds the permission. Reads work in every state.
   */
  adminBalanceOf(
    context: CallContext,
    customerAccountId: Id<'Account'>,
  ): Promise<Result<WalletBalanceView, WalletFailure>>;

  /**
   * The calling customer's own balance (rule `own-resources`, customers only; the account is the
   * session's). For a customer's own request that needs a yes or no on the wallet, such as account
   * deletion. Reads work in every state.
   */
  ownBalanceOf(context: CallContext): Promise<Result<WalletBalanceView, WalletFailure>>;
}

/** Nest token of the {@link WalletFacade}, provided by `WalletModule`. */
export const WALLET_FACADE = Symbol('WALLET_FACADE');
