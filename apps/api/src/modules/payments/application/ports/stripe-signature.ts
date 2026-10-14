/** Which Stripe endpoint signed the request: the platform's own events or its Connect events. */
export type SignatureKind = 'platform' | 'connect';

/**
 * Checks the `Stripe-Signature` header against the exact bytes of the request body with the
 * signing secret of the Market's endpoint, within the timestamp tolerance. Stripe signs platform
 * events and connected-account events with different secrets, so the answer names which one
 * matched.
 */
export interface StripeSignature {
  /** False when the Market has no secret at all: then nothing can be verified for it. */
  configuredFor(marketId: string): boolean;
  /** The kind of the secret that matched, or null. */
  verify(marketId: string, payload: Uint8Array, header: unknown): SignatureKind | null;
}

export const STRIPE_SIGNATURE = Symbol('STRIPE_SIGNATURE');
