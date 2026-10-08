import { createHmac, hkdfSync } from 'node:crypto';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { IdentifierIndex } from '../application/ports/identifier-index';
import {
  identifierIndexKeyOf,
  type IdentifierIndexKey,
  type NormalisedIdentifier,
} from '../domain/business-identifier';

const SECRET_BYTES = 32;

/**
 * The HKDF info of the identifier-index key (data design 4.4, O3): one stack secret, distinct
 * labels per use, so the index and the rate-counter keys can never be compared.
 */
const IDENTIFIER_INDEX_INFO = 'sellers.identifier-index';

/**
 * {@link IdentifierIndex} (sellers design 8.2; data design S5): HMAC-SHA-256 under a key derived
 * with HKDF-SHA-256 from the sellers stack secret. The message is a JSON array of Market, scheme
 * and normalised value, so no two different inputs share a message and equal values collide only
 * inside one Market and scheme. Neither the secret, the key nor an index is ever logged.
 */
export class HmacIdentifierIndex implements IdentifierIndex {
  readonly #key: Buffer;

  constructor(secret: Uint8Array) {
    if (secret.length !== SECRET_BYTES) throw new TypeError('The sellers secret is 32 bytes');
    this.#key = Buffer.from(
      hkdfSync('sha256', secret, new Uint8Array(0), IDENTIFIER_INDEX_INFO, SECRET_BYTES),
    );
  }

  of(market: MarketContext, scheme: string, normalised: NormalisedIdentifier): IdentifierIndexKey {
    if (typeof scheme !== 'string' || scheme.length === 0) {
      throw new TypeError('An identifier scheme is a non-empty string');
    }
    if (typeof normalised !== 'string' || normalised.length === 0) {
      throw new TypeError('A normalised identifier is a non-empty string');
    }
    return identifierIndexKeyOf(
      new Uint8Array(
        createHmac('sha256', this.#key)
          .update(JSON.stringify([market.marketId, scheme, normalised]))
          .digest(),
      ),
    );
  }
}
