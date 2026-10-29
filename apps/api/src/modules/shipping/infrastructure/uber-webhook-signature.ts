import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FleetWebhookSignature } from '../application/ports/fleet-webhook-signature';

const MAX_HEADER_LENGTH = 200;

/**
 * Uber Direct's webhook signature (Uber's public webhook documentation): the `x-uber-signature`
 * header is the lower-case hex HMAC-SHA256 of the raw request body under the webhook signing
 * secret. Upper-case hex is accepted too. The comparison is constant time over the raw bytes; the
 * secret (`UBER_DIRECT_WEBHOOK_SECRET`, one per Market) is never logged.
 */
export class UberWebhookSignature implements FleetWebhookSignature {
  constructor(private readonly secrets: Readonly<Record<string, string>>) {}

  configuredFor(marketId: string): boolean {
    return Object.hasOwn(this.secrets, marketId);
  }

  verify(marketId: string, payload: Uint8Array, signature: unknown): boolean {
    const secret = Object.hasOwn(this.secrets, marketId) ? this.secrets[marketId] : undefined;
    if (secret === undefined) return false;
    if (typeof signature !== 'string' || signature.length > MAX_HEADER_LENGTH) return false;
    const given = signature.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(given)) return false;
    const expected = createHmac('sha256', secret).update(payload).digest();
    return timingSafeEqual(Buffer.from(given, 'hex'), expected);
  }
}
