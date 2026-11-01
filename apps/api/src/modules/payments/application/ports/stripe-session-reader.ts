import type { Result } from '@mondapac/shared-kernel';

/** What payments needs of a Checkout session and its PaymentIntent, read again from Stripe. */
export interface CheckoutSessionSnapshot {
  readonly id: string;
  readonly livemode: boolean;
  /** open, complete or expired. */
  readonly status: string;
  /** paid, unpaid or no_payment_required. */
  readonly paymentStatus: string;
  /** `client_reference_id`, set by ordering to the order id. */
  readonly clientReferenceId: string | null;
  readonly metadataOrderId: string | null;
  readonly metadataMarketId: string | null;
  /** Null when the session has no PaymentIntent yet. */
  readonly paymentIntent: {
    readonly id: string;
    /** requires_capture (held), succeeded (captured), canceled, ... */
    readonly status: string;
    /** Lowercase ISO 4217, as Stripe sends it. */
    readonly currency: string;
    readonly amountCapturable: bigint;
    readonly amountReceived: bigint;
  } | null;
}

export type ReadFailure =
  /** Stripe could not be reached or answered with a server error: try again later. */
  | { readonly code: 'payment.provider-unavailable' }
  /** Stripe refused the read (unknown session, wrong key): it will not succeed on a retry. */
  | { readonly code: 'payment.provider-rejected' };

/** What payments needs of a PaymentIntent made by the card payment on the MondaPac page. */
export interface PaymentIntentSnapshot {
  readonly id: string;
  readonly livemode: boolean;
  /** requires_capture (held), requires_payment_method (failed), canceled, ... */
  readonly status: string;
  /** Lowercase ISO 4217, as Stripe sends it. */
  readonly currency: string;
  readonly amountCapturable: bigint;
  readonly metadataOrderId: string | null;
  readonly metadataMarketId: string | null;
  /** `card-intent` on every PaymentIntent of that flow. */
  readonly metadataPaymentFlow: string | null;
}

/** Reads a Checkout session or a PaymentIntent from Stripe; the webhook payload is never trusted. */
export interface StripeSessionReader {
  readCheckoutSession(sessionId: string): Promise<Result<CheckoutSessionSnapshot, ReadFailure>>;
  readPaymentIntent(intentId: string): Promise<Result<PaymentIntentSnapshot, ReadFailure>>;
}

export const STRIPE_SESSION_READER = Symbol('STRIPE_SESSION_READER');
