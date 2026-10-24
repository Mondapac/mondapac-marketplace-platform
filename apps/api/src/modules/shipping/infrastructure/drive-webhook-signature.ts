import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@mondapac/shared-kernel';
import type { CarrierWebhookSignature } from '../application/ports/carrier-webhook-signature';

/** How far the signed timestamp may be from now, either way: the replay window. */
export const DRIVE_SIGNATURE_TOLERANCE_SECONDS = 300;
const MAX_HEADER_LENGTH = 1024;
/** More than one `v1` lets Drive sign with an old and a new secret while one is rotated. */
const MAX_SIGNATURES = 4;

/**
 * Mondapac Drive's webhook signature (handoff 09, the format Drive's notifications package
 * emits): the `Drive-Timestamp` header is the Unix time in seconds, and `Drive-Signature` is
 * `v1=<hex>[,v1=<hex>]`, each the HMAC-SHA256 under the Market's webhook secret of
 * `<timestamp>.<raw body>`. One matching `v1` within the tolerance passes; the comparison is
 * constant time. The secret is never logged.
 */
export class DriveWebhookSignature implements CarrierWebhookSignature {
  constructor(
    private readonly secrets: Readonly<Record<string, string>>,
    private readonly clock: Clock,
  ) {}

  configuredFor(marketId: string): boolean {
    return Object.hasOwn(this.secrets, marketId);
  }

  verify(
    marketId: string,
    payload: Uint8Array,
    headers: { readonly timestamp: unknown; readonly signature: unknown },
  ): boolean {
    const secret = Object.hasOwn(this.secrets, marketId) ? this.secrets[marketId] : undefined;
    const { timestamp, signature } = headers;
    if (secret === undefined) return false;
    if (typeof timestamp !== 'string' || !/^[0-9]{1,12}$/.test(timestamp)) return false;
    if (typeof signature !== 'string' || signature.length > MAX_HEADER_LENGTH) return false;
    const candidates: Buffer[] = [];
    for (const part of signature.split(',')) {
      const [scheme, value, extra] = part.trim().split('=');
      if (extra !== undefined || value === undefined) return false;
      if (scheme === 'v1') {
        if (!/^[0-9a-f]{64}$/.test(value)) return false;
        candidates.push(Buffer.from(value, 'hex'));
      }
    }
    if (candidates.length === 0 || candidates.length > MAX_SIGNATURES) return false;
    const now = Math.floor(this.clock.now().epochMilliseconds / 1000);
    if (Math.abs(now - Number(timestamp)) > DRIVE_SIGNATURE_TOLERANCE_SECONDS) return false;
    const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest();
    // Every candidate is compared, so the time taken does not depend on which one matched.
    return candidates.reduce(
      (matched, candidate) => timingSafeEqual(candidate, expected) || matched,
      false,
    );
  }
}
