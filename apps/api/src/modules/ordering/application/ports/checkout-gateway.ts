import type { Result, Temporal } from '@mondapac/shared-kernel';

export interface CreateSessionRequest {
  readonly orderId: string;
  readonly marketId: string;
  readonly currency: string;
  /** One Checkout line per seller package: the label and the total in minor units. */
  readonly packages: readonly { readonly label: string; readonly amount: bigint }[];
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly expiresAt: Temporal.Instant;
  /** Stored on the order before this call; the same key on every retry. */
  readonly idempotencyKey: string;
}

export type GatewayFailure =
  /** The provider could not be reached or answered with a server error: nothing is known. */
  | { readonly code: 'payment.provider-unavailable' }
  /** The provider refused the request: it will not succeed on a retry. */
  | { readonly code: 'payment.provider-rejected' };

/**
 * The hosted payment page of the payment provider (Stripe Checkout), behind one small adapter.
 * Authorise first, capture once the stock is committed (manual capture). Never retries a money
 * call with a new key; a failure is returned, not thrown.
 */
export interface CheckoutGateway {
  createSession(
    request: CreateSessionRequest,
  ): Promise<Result<{ readonly sessionId: string; readonly url: string }, GatewayFailure>>;

  /** Stops an unpaid session accepting payment. Best effort: never throws. */
  expireSession(sessionId: string): Promise<void>;

  /** Takes the authorised money. */
  capture(paymentIntentId: string, idempotencyKey: string): Promise<Result<true, GatewayFailure>>;

  /** Releases the authorisation (a void): the card is not charged. */
  voidAuthorisation(
    paymentIntentId: string,
    idempotencyKey: string,
  ): Promise<Result<true, GatewayFailure>>;

  /**
   * Gives `amount` (minor units) of the captured money back to the card (tax step 3). Test mode
   * only: with a live key the adapter refuses without calling Stripe. Answers Stripe's refund id.
   */
  refund(
    request: RefundCallRequest,
  ): Promise<Result<{ readonly refundId: string }, GatewayFailure>>;
}

export interface RefundCallRequest {
  readonly paymentIntentId: string;
  readonly amount: bigint;
  readonly orderId: string;
  readonly refundId: string;
  readonly marketId: string;
  /** Stored on the refund before this call; the same key on every retry. */
  readonly idempotencyKey: string;
}

export const CHECKOUT_GATEWAY = Symbol('CHECKOUT_GATEWAY');
