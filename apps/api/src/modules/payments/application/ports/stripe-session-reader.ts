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

/** Reads a Checkout session from Stripe; the webhook payload itself is never trusted. */
export interface StripeSessionReader {
  readCheckoutSession(sessionId: string): Promise<Result<CheckoutSessionSnapshot, ReadFailure>>;
}

export const STRIPE_SESSION_READER = Symbol('STRIPE_SESSION_READER');
