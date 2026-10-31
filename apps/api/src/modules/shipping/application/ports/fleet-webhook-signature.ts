/**
 * The signature check of a fleet whose webhook carries one header and no timestamp (Uber Direct):
 * the hex HMAC-SHA256 of the exact raw body under the Market's signing secret. The secret never
 * leaves it. Replays are stopped by the event id, not by a clock.
 */
export interface FleetWebhookSignature {
  /** False when the Market has no signing secret: every event is refused (503, retried). */
  configuredFor(marketId: string): boolean;

  /** True only for a header that matches the raw body, compared in constant time. */
  verify(marketId: string, payload: Uint8Array, signature: unknown): boolean;
}

export const UBER_WEBHOOK_SIGNATURE = Symbol('UBER_WEBHOOK_SIGNATURE');
