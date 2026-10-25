/**
 * The signature check of a carrier's webhooks: HMAC-SHA256 under the Market's shared secret over
 * `<timestamp>.<raw body>`, the timestamp within the replay window. The secret never leaves it.
 */
export interface CarrierWebhookSignature {
  /** False when the Market has no webhook secret: every event is refused (503, retried). */
  configuredFor(marketId: string): boolean;

  verify(
    marketId: string,
    payload: Uint8Array,
    headers: { readonly timestamp: unknown; readonly signature: unknown },
  ): boolean;
}

export const CARRIER_WEBHOOK_SIGNATURE = Symbol('CARRIER_WEBHOOK_SIGNATURE');
