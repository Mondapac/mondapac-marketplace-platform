import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { PREVIEW_TOKEN_TTL_MINUTES, type PreviewTokens } from '../application/ports/preview-tokens';

/** The HKDF info of the preview key: distinct from every other use of a secret. */
const PREVIEW_INFO = 'assistant.preview-token';
/** What the MAC says the token is for, so a MAC of another purpose never verifies here. */
const PURPOSE = 'assistant-internal-preview';
/** The token's version prefix; a new format gets a new one. */
const VERSION = 'ap1';
/** `ap1.<expiry, Unix seconds>.<16 random bytes>.<HMAC-SHA-256>`, base64url without padding. */
const TOKEN_PATTERN = /^ap1\.([1-9][0-9]{9})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
/** Clock skew tolerated between API instances when checking that an expiry is not too far. */
const SKEW_SECONDS = 60;

/**
 * {@link PreviewTokens}: HMAC-SHA-256 under a key derived with HKDF-SHA-256 from
 * `ASSISTANT_PREVIEW_TOKEN_KEY`, over a JSON array (purpose, Market, expiry, nonce). The Market is
 * in the MAC but not in the token, so a token of one Market never verifies in another. The token
 * names no account. A token whose expiry is past, or further away than the lifetime allows, is
 * refused; the MAC is compared in constant time. The key and the tokens are never logged; changing
 * the key revokes every token at once.
 */
export class HmacPreviewTokens implements PreviewTokens {
  readonly #key: Buffer | null;

  constructor(secret: string | null) {
    this.#key =
      secret === null
        ? null
        : Buffer.from(
            hkdfSync('sha256', Buffer.from(secret, 'utf8'), new Uint8Array(0), PREVIEW_INFO, 32),
          );
  }

  available(): boolean {
    return this.#key !== null;
  }

  issue(market: MarketContext, now: Temporal.Instant) {
    if (this.#key === null) return null;
    const expiresAt = Temporal.Instant.fromEpochMilliseconds(
      Math.floor(now.epochMilliseconds / 1000) * 1000,
    ).add({ minutes: PREVIEW_TOKEN_TTL_MINUTES });
    const expiry = String(expiresAt.epochMilliseconds / 1000);
    const nonce = randomBytes(16).toString('base64url');
    const mac = this.#mac(this.#key, market, expiry, nonce).toString('base64url');
    return { token: `${VERSION}.${expiry}.${nonce}.${mac}`, expiresAt };
  }

  verify(market: MarketContext, token: unknown, now: Temporal.Instant): boolean {
    if (this.#key === null || typeof token !== 'string' || token.length > 120) return false;
    const match = TOKEN_PATTERN.exec(token);
    if (match === null) return false;
    const [, expiry, nonce, given] = match as unknown as [string, string, string, string];
    const nowSeconds = now.epochMilliseconds / 1000;
    const expires = Number(expiry);
    if (expires <= nowSeconds) return false;
    if (expires > nowSeconds + PREVIEW_TOKEN_TTL_MINUTES * 60 + SKEW_SECONDS) return false;
    const expected = this.#mac(this.#key, market, expiry, nonce);
    const received = Buffer.from(given, 'base64url');
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  #mac(key: Buffer, market: MarketContext, expiry: string, nonce: string): Buffer {
    return createHmac('sha256', key)
      .update(JSON.stringify([PURPOSE, market.marketId, expiry, nonce]))
      .digest();
  }
}
