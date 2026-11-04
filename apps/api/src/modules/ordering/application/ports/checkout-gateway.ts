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
   * only: with a live key the adapter refuses without calling Stripe. Answers Stripe's refund id
   * and where it stands: only `succeeded` is final money back (Hassan M1); `pending` is read
   * again later with {@link refundStatus}; `failed` gave nothing back.
   */
  refund(request: RefundCallRequest): Promise<Result<RefundAnswer, GatewayFailure>>;

  /** Reads a refund Stripe already made, by its id (test mode only, as `refund`). */
  refundStatus(stripeRefundId: string): Promise<Result<RefundAnswer, GatewayFailure>>;

  /**
   * What the buyer's browser gave Stripe for a card payment (a ConfirmationToken), read from
   * Stripe: the card brand and the mode. Nothing else of the card is read or kept.
   */
  readConfirmationToken(
    confirmationToken: string,
  ): Promise<Result<ConfirmationTokenFacts, GatewayFailure>>;

  /**
   * Authorises the card payment of one order: a manual-capture PaymentIntent confirmed with the
   * token, the amount and currency from the order (never from the client). Test mode only: with a
   * live key the adapter refuses without calling Stripe. Nothing is captured here.
   */
  payByCard(request: PayByCardRequest): Promise<Result<CardPaymentAnswer, CardPaymentFailure>>;
}

/** The facts of a ConfirmationToken that ordering decides on. */
export interface ConfirmationTokenFacts {
  /** Always false here: a live-mode token is refused by the adapter. */
  readonly livemode: boolean;
  /** `card` for a card and for Apple Pay or Google Pay; anything else is not accepted. */
  readonly methodType: string;
  /** Lowercase brand Stripe reports (`visa`, `mastercard`, ...); null when it is not a card. */
  readonly cardBrand: string | null;
}

export interface PayByCardRequest {
  readonly orderId: string;
  readonly marketId: string;
  readonly currency: string;
  /** The order total in minor units, computed on the server. */
  readonly amount: bigint;
  readonly confirmationToken: string;
  /** Where Stripe sends the buyer back after an authentication step (3DS). */
  readonly returnUrl: string;
  /** Stored on the order before this call; the same key on every retry. */
  readonly idempotencyKey: string;
}

/** Where the payment stands after the confirm. */
export type CardPaymentAnswer =
  /** The card holds the money (`requires_capture`). */
  | { readonly status: 'authorised'; readonly paymentIntentId: string }
  /** The buyer's bank asks for authentication (3DS): the browser finishes it with the secret. */
  | {
      readonly status: 'requires-action';
      readonly paymentIntentId: string;
      readonly clientSecret: string;
    };

export type CardPaymentFailure =
  | GatewayFailure
  /** The card was declined or failed authentication; `paymentIntentId` is set when Stripe made one. */
  | { readonly code: 'payment.card-declined'; readonly paymentIntentId: string | null };

/** Stripe's refund and its state: `pending` covers Stripe's `pending` and `requires_action`. */
export interface RefundAnswer {
  readonly refundId: string;
  readonly status: 'succeeded' | 'pending' | 'failed';
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
