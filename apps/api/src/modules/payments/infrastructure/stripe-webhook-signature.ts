import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@mondapac/shared-kernel';
import type { StripeSignature } from '../application/ports/stripe-signature';

/** How far the signed timestamp may be from now, either way: Stripe's own default. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const MAX_HEADER_LENGTH = 2048;
const MAX_SIGNATURES = 8;

/**
 * Stripe's webhook signature scheme, without the SDK: the header is
 * `t=<unix seconds>,v1=<hex>[,v1=<hex>...]` and each `v1` is the HMAC-SHA256, keyed with the
 * endpoint's signing secret, of `<t>.<raw body>`. One matching `v1` within the tolerance passes;
 * the comparison is constant time. Other schemes (`v0`) are ignored. The secret is never logged.
 */
export class StripeWebhookSignature implements StripeSignature {
  constructor(
    private readonly secret: string | null,
    private readonly clock: Clock,
  ) {}

  get configured(): boolean {
    return this.secret !== null;
  }

  verify(payload: Uint8Array, header: unknown): boolean {
    if (this.secret === null || typeof header !== 'string' || header.length > MAX_HEADER_LENGTH) {
      return false;
    }
    let timestamp: number | null = null;
    const signatures: Buffer[] = [];
    for (const part of header.split(',')) {
      const [key, value, extra] = part.split('=');
      if (extra !== undefined || value === undefined) return false;
      if (key === 't') {
        if (timestamp !== null || !/^[0-9]{1,12}$/.test(value)) return false;
        timestamp = Number(value);
      } else if (key === 'v1') {
        if (!/^[0-9a-f]{64}$/.test(value)) return false;
        signatures.push(Buffer.from(value, 'hex'));
      }
    }
    if (timestamp === null || signatures.length === 0 || signatures.length > MAX_SIGNATURES) {
      return false;
    }
    const now = Math.floor(this.clock.now().epochMilliseconds / 1000);
    if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
    const expected = createHmac('sha256', this.secret)
      .update(`${timestamp}.`)
      .update(payload)
      .digest();
    // Every candidate is compared, so the time taken does not depend on which one matched.
    return signatures.reduce(
      (matched, candidate) => timingSafeEqual(candidate, expected) || matched,
      false,
    );
  }
}
