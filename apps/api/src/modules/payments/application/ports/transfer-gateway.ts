import type { Result } from '@mondapac/shared-kernel';
import type { ProviderTransfer } from '../../domain/transfer';

/** The answer to a transfer create call: the only three things payments tells apart. */
export type TransferCreateAnswer =
  /** Stripe created it. */
  | { readonly kind: 'created'; readonly ref: string }
  /** Stripe answered with a client error (not 409 or 429): nothing was created. */
  | { readonly kind: 'refused'; readonly code: 'insufficient-balance' | 'provider-refused' }
  /** A timeout, a lost connection, 409, 429 or a server error: the transfer may exist. */
  | { readonly kind: 'unknown' };

/** A transfer as read back from Stripe: the facts payments matches and nothing else. */
export interface TransferSnapshot extends ProviderTransfer {
  readonly livemode: boolean;
  /** `metadata.market_id`, which payments puts on every transfer it creates. */
  readonly marketId: string | null;
  /** The amount Stripe reports as reversed so far. */
  readonly amountReversedMinor: bigint;
}

export type TransferReadFailure =
  | { readonly code: 'payment.provider-unavailable' }
  | { readonly code: 'payment.provider-rejected' };

/** What payments asks Stripe about transfers. Test mode only. */
export interface StripeTransferGateway {
  /** False while no Stripe key is configured: no transfer is reserved then. */
  available(): boolean;

  /**
   * POST /v1/transfers with `Idempotency-Key = key`, one request, never retried here: a transfer
   * is repeated by no one (an unknown answer is looked up, not sent again).
   */
  createTransfer(request: {
    readonly destination: string;
    readonly amountMinor: bigint;
    /** Upper-case ISO 4217. */
    readonly currency: string;
    /** The transfer group: the payout id of commission-payouts. */
    readonly transferGroup: string;
    /** The instruction key: the idempotency key and `metadata.mp_key`. */
    readonly key: string;
    readonly payoutId: string;
    readonly marketId: string;
  }): Promise<TransferCreateAnswer>;

  /**
   * The transfers of one transfer group (GET /v1/transfers?transfer_group=...). A failure, or
   * more transfers than one page holds, is a failure: a lookup that is not complete never says
   * "not found".
   */
  listTransfersByGroup(
    group: string,
  ): Promise<Result<readonly TransferSnapshot[], TransferReadFailure>>;

  /** One transfer as Stripe reports it now (GET /v1/transfers/:id). */
  readTransfer(transferId: string): Promise<Result<TransferSnapshot, TransferReadFailure>>;
}

export const STRIPE_TRANSFER_GATEWAY = Symbol('STRIPE_TRANSFER_GATEWAY');
