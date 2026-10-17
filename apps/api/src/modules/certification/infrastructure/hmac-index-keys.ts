import { createHmac, hkdfSync } from 'node:crypto';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { CertificateIndexKeys } from '../application/ports/review.ports';

const SECRET_BYTES = 32;

/** The HKDF info of the index key: distinct from the rate-counter key and from every other module's. */
const INDEX_INFO = 'certification.keyed-index';

/**
 * {@link CertificateIndexKeys} (data design 3.17, certification design 10.2): HMAC-SHA-256 under a
 * key derived with HKDF-SHA-256 from the certification stack secret. The Market, the type and the
 * kind are in the input, as a length-prefixed header before the value, so two different inputs
 * never share a message and a number never collides with a file. The stack secret differs from
 * `sellers`' identifier-index secret (each module derives from its own secret). The secret and the
 * derived key are never logged. The indexes are pseudonymous personal data: they survive the
 * seller's key, so the erasure handler deletes the seller's rows.
 */
export class HmacCertificateIndexKeys implements CertificateIndexKeys {
  readonly #key: Buffer;

  constructor(secret: Uint8Array) {
    if (secret.length !== SECRET_BYTES) {
      throw new TypeError('The certification secret is 32 bytes');
    }
    this.#key = Buffer.from(
      hkdfSync('sha256', secret, new Uint8Array(0), INDEX_INFO, SECRET_BYTES),
    );
  }

  numberHmac(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
    normalised: string,
  ): Uint8Array {
    return this.#mac('number', market, typeId, Buffer.from(normalised, 'utf8'));
  }

  documentHmac(market: MarketContext, typeId: Id<'CertificationType'>, bytes: Buffer): Uint8Array {
    return this.#mac('file', market, typeId, bytes);
  }

  #mac(kind: string, market: MarketContext, typeId: string, value: Uint8Array): Uint8Array {
    const header = Buffer.from(JSON.stringify([kind, market.marketId, typeId]), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    return new Uint8Array(
      createHmac('sha256', this.#key).update(length).update(header).update(value).digest(),
    );
  }
}
