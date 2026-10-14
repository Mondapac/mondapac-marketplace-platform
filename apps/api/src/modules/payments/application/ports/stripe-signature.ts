/**
 * Checks the `Stripe-Signature` header against the exact bytes of the request body with the
 * endpoint's signing secret, within the timestamp tolerance.
 */
export interface StripeSignature {
  /** False when no secret is configured: then nothing can be verified. */
  readonly configured: boolean;
  verify(payload: Uint8Array, header: unknown): boolean;
}

export const STRIPE_SIGNATURE = Symbol('STRIPE_SIGNATURE');
