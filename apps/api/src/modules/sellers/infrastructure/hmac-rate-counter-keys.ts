import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { AppConfig } from '../../../platform/config/app-config';
import type { RateCounterKeys } from '../application/ports/rate-counter-keys';
import type { RateCounterKind } from '../domain/rate-limits';

const SECRET_BYTES = 32;

/**
 * The HKDF info of the rate-counter key (data design 4.4, O3): `sellers` derives its keyed
 * hashes from one stack secret with distinct labels (`sellers.identifier-index` joins in slice
 * 3), so the two can never be compared.
 */
const RATE_COUNTER_INFO = 'sellers.rate-counter';

/**
 * {@link RateCounterKeys} (data design 3.11): HMAC-SHA-256 under a key derived with HKDF-SHA-256
 * from the sellers stack secret. The parts are a JSON array (kind, Market, subject), so no two
 * different inputs share a message and two kinds never share a key. The secret and the derived
 * key are never logged; rotating them only resets the counters.
 */
export class HmacRateCounterKeys implements RateCounterKeys {
  readonly #key: Buffer;

  constructor(secret: Uint8Array) {
    if (secret.length !== SECRET_BYTES) throw new TypeError('The sellers secret is 32 bytes');
    this.#key = Buffer.from(
      hkdfSync('sha256', secret, new Uint8Array(0), RATE_COUNTER_INFO, SECRET_BYTES),
    );
  }

  keyOf(market: MarketContext, kind: RateCounterKind, subject: string): Uint8Array {
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new TypeError('A rate counter subject is a non-empty string');
    }
    return new Uint8Array(
      createHmac('sha256', this.#key)
        .update(JSON.stringify([kind, market.marketId, subject]))
        .digest(),
    );
  }
}

/** The stand-in was asked to start outside an explicit development or test environment. */
export class LocalSellersSecretRefusedError extends Error {
  override readonly name = 'LocalSellersSecretRefusedError';
  constructor() {
    super(
      'The sellers stack secret is a local stand-in: it starts only when NODE_ENV is explicitly ' +
        '"development" or "test". The deployed secret (32 random bytes, data design 4.4) is not ' +
        'wired yet',
    );
  }
}

/**
 * The local and CI stand-in of the sellers stack secret (data design 4.4), like identity's
 * throttle secret (H4): derived from a constant of this file, distinct from identity's, so it is
 * NOT a secret, which is why it refuses to start unless `NODE_ENV` was explicitly set to
 * `development` or `test`. Where the deployed secret lives is Kazem's decision with the first
 * deployed environment (K1); until then a production start fails here.
 */
export function localSellersSecret(
  environment: Pick<AppConfig, 'nodeEnv' | 'nodeEnvExplicit'>,
): Uint8Array {
  const { nodeEnv, nodeEnvExplicit } = environment;
  if (nodeEnvExplicit !== true || (nodeEnv !== 'development' && nodeEnv !== 'test')) {
    throw new LocalSellersSecretRefusedError();
  }
  new Logger('HmacRateCounterKeys').warn({
    msg: 'sellers.stack-secret.local-stand-in',
    nodeEnv,
    note: 'sellers rate-counter keys use the local stand-in secret, which protects nothing',
  });
  return new Uint8Array(
    createHash('sha256').update('mondapac.sellers.secret.stand-in.v1').digest(),
  );
}
