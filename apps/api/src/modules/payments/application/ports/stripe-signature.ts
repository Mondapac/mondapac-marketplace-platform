/**
 * Checks the `Stripe-Signature` header against the exact bytes of the request body with the
 * signing secret of the Market's endpoint, within the timestamp tolerance.
 */
export interface StripeSignature {
  /** False when the Market has no secret: then nothing can be verified for it. */
  configuredFor(marketId: string): boolean;
  verify(marketId: string, payload: Uint8Array, header: unknown): boolean;
}

export const STRIPE_SIGNATURE = Symbol('STRIPE_SIGNATURE');
