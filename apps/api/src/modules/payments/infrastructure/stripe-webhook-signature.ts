import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@mondapac/shared-kernel';
import type { SignatureKind, StripeSignature } from '../application/ports/stripe-signature';

/** How far the signed timestamp may be from now, either way: Stripe's own default. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const MAX_HEADER_LENGTH = 2048;
const MAX_SIGNATURES = 8;

/**
 * Stripe's webhook signature scheme, without the SDK: the header is
 * `t=<unix seconds>,v1=<hex>[,v1=<hex>...]` and each `v1` is the HMAC-SHA256, keyed with the
 * signing secret of the Market's endpoint, of `<t>.<raw body>`. One matching `v1` within the tolerance passes;
 * the comparison is constant time. Other schemes (`v0`) are ignored. The secret is never logged.
 */
export class StripeWebhookSignature implements StripeSignature {
  constructor(
    private readonly secrets: Readonly<Record<string, string>>,
    private readonly clock: Clock,
    private readonly connectSecrets: Readonly<Record<string, string>> = {},
  ) {}

  configuredFor(marketId: string): boolean {
    return Object.hasOwn(this.secrets, marketId) || Object.hasOwn(this.connectSecrets, marketId);
  }

  verify(marketId: string, payload: Uint8Array, header: unknown): SignatureKind | null {
    const tries: [SignatureKind, Readonly<Record<string, string>>][] = [
      ['platform', this.secrets],
      ['connect', this.connectSecrets],
    ];
    let matched: SignatureKind | null = null;
    for (const [kind, secrets] of tries) {
      const secret = Object.hasOwn(secrets, marketId) ? secrets[marketId] : undefined;
      if (secret !== undefined && this.matches(secret, payload, header)) matched ??= kind;
    }
    return matched;
  }

  private matches(secret: string, payload: Uint8Array, header: unknown): boolean {
    if (typeof header !== 'string' || header.length > MAX_HEADER_LENGTH) return false;
    let timestamp: string | null = null;
    const signatures: Buffer[] = [];
    for (const part of header.split(',')) {
      const [key, value, extra] = part.split('=');
      if (extra !== undefined || value === undefined) return false;
      if (key === 't') {
        if (timestamp !== null || !/^[0-9]{1,12}$/.test(value)) return false;
        timestamp = value;
      } else if (key === 'v1') {
        if (!/^[0-9a-f]{64}$/.test(value)) return false;
        signatures.push(Buffer.from(value, 'hex'));
      }
    }
    if (timestamp === null || signatures.length === 0 || signatures.length > MAX_SIGNATURES) {
      return false;
    }
    const now = Math.floor(this.clock.now().epochMilliseconds / 1000);
    if (Math.abs(now - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
    // The signed payload uses `t` exactly as sent, as Stripe's own libraries do.
    const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest();
    // Every candidate is compared, so the time taken does not depend on which one matched.
    return signatures.reduce(
      (matched, candidate) => timingSafeEqual(candidate, expected) || matched,
      false,
    );
  }
}
