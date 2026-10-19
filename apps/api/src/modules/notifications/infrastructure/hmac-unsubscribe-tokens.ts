import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { parseId } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { AppConfig } from '../../../platform/config/app-config';
import type { UnsubscribeTokens } from '../application/ports/unsubscribe-tokens';

const SECRET_BYTES = 32;

/** The HKDF info of the unsubscribe key: distinct from every other module's label. */
const UNSUBSCRIBE_INFO = 'notifications.unsubscribe-link';

/** The token's version prefix; a new format gets a new one and the old keeps verifying. */
const VERSION = 'u1';

const TOKEN_PATTERN = /^u1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

/**
 * {@link UnsubscribeTokens}: `u1.<account id>.<mac>`, where the MAC is HMAC-SHA-256 under a key
 * derived with HKDF-SHA-256 from the notifications stack secret, over a JSON array (purpose,
 * Market, account). The Market is in the MAC but not in the token, so a token of one Market never
 * verifies in another. Compared in constant time. The secret and the key are never logged.
 */
export class HmacUnsubscribeTokens implements UnsubscribeTokens {
  readonly #key: Buffer;

  constructor(secret: Uint8Array) {
    if (secret.length !== SECRET_BYTES) throw new TypeError('The notifications secret is 32 bytes');
    this.#key = Buffer.from(
      hkdfSync('sha256', secret, new Uint8Array(0), UNSUBSCRIBE_INFO, SECRET_BYTES),
    );
  }

  issue(market: MarketContext, accountId: Id<'Account'>): string {
    return `${VERSION}.${accountId}.${this.#mac(market, accountId).toString('base64url')}`;
  }

  verify(market: MarketContext, token: unknown): Id<'Account'> | null {
    if (typeof token !== 'string' || token.length > 100) return null;
    const match = TOKEN_PATTERN.exec(token);
    if (match === null) return null;
    const parsed = parseId<'Account'>(match[1]!);
    if (!parsed.ok) return null;
    const given = Buffer.from(match[2]!, 'base64url');
    const expected = this.#mac(market, parsed.value);
    return given.length === expected.length && timingSafeEqual(given, expected)
      ? parsed.value
      : null;
  }

  #mac(market: MarketContext, accountId: string): Buffer {
    return createHmac('sha256', this.#key)
      .update(JSON.stringify(['unsubscribe-marketing-email', market.marketId, accountId]))
      .digest();
  }
}

/** The stand-in was asked to start outside an explicit development or test environment. */
export class LocalNotificationsSecretRefusedError extends Error {
  override readonly name = 'LocalNotificationsSecretRefusedError';
  constructor() {
    super(
      'The notifications stack secret is a local stand-in: it starts only when NODE_ENV is ' +
        'explicitly "development" or "test". The deployed secret (32 random bytes) is not wired yet',
    );
  }
}

/**
 * The local and CI stand-in of the notifications stack secret, like catalog's: derived from a
 * constant of this file, so it is NOT a secret, which is why it refuses to start unless
 * `NODE_ENV` was explicitly set to `development` or `test`. Where the deployed secret lives is
 * Kazem's decision with the first deployed environment (K1).
 */
export function localNotificationsSecret(
  environment: Pick<AppConfig, 'nodeEnv' | 'nodeEnvExplicit'>,
): Uint8Array {
  const { nodeEnv, nodeEnvExplicit } = environment;
  if (nodeEnvExplicit !== true || (nodeEnv !== 'development' && nodeEnv !== 'test')) {
    throw new LocalNotificationsSecretRefusedError();
  }
  new Logger('HmacUnsubscribeTokens').warn({
    msg: 'notifications.stack-secret.local-stand-in',
    nodeEnv,
    note: 'unsubscribe links use the local stand-in secret, which protects nothing',
  });
  return new Uint8Array(
    createHash('sha256').update('mondapac.notifications.secret.stand-in.v1').digest(),
  );
}
