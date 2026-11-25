import { createHmac, hkdfSync } from 'node:crypto';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { OfferPostReviewSampler } from '../application/ports/offer-post-review';
import { sampleBucketOf } from '../domain/offer-post-review';

const SECRET_BYTES = 32;

/** The HKDF info of the sampling key: distinct from the rate-counter key and every other label. */
const SAMPLING_INFO = 'catalog.offer-review-sampling';

/**
 * {@link OfferPostReviewSampler} (risk-based Offer approval slice 6): HMAC-SHA-256 under a key
 * derived with HKDF-SHA-256 from the catalog stack secret (its own info label, as
 * `HmacRateCounterKeys`), over `JSON.stringify(['offer-review-sample', marketId, offerId,
 * offerVersion])`; the first four bytes, big-endian, scaled to a bucket of 0 to 9,999. Without the
 * key nobody can tell which Offers are drawn. The secret, the key and the digest are never logged
 * or returned.
 */
export class HmacOfferPostReviewSampler implements OfferPostReviewSampler {
  readonly #key: Buffer;

  constructor(secret: Uint8Array) {
    if (secret.length !== SECRET_BYTES) throw new TypeError('The catalog secret is 32 bytes');
    this.#key = Buffer.from(
      hkdfSync('sha256', secret, new Uint8Array(0), SAMPLING_INFO, SECRET_BYTES),
    );
  }

  bucketOf(market: MarketContext, offerId: Id<'Offer'>, offerVersion: number): number {
    if (typeof offerId !== 'string' || offerId.length === 0) {
      throw new TypeError('A sampled Offer id is a non-empty string');
    }
    if (!Number.isSafeInteger(offerVersion) || offerVersion < 1) {
      throw new TypeError('A sampled Offer version is a positive whole number');
    }
    const digest = createHmac('sha256', this.#key)
      .update(JSON.stringify(['offer-review-sample', market.marketId, offerId, offerVersion]))
      .digest();
    return sampleBucketOf(digest);
  }
}
