import { createHmac, hkdfSync } from 'node:crypto';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import type { Id } from '@mondapac/shared-kernel';
import { SAMPLE_BUCKETS, isSampled, sampleBucketOf } from '../domain/offer-post-review';
import { HmacRateCounterKeys } from './hmac-rate-counter-keys';
import { HmacOfferPostReviewSampler } from './hmac-offer-post-review-sampler';

const secret = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const offer = (n: number) =>
  `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Offer'>;

describe('catalog HmacOfferPostReviewSampler (slice 6)', () => {
  const au = testMarketContext('AU', 'default');
  const zz = testMarketContext('ZZ', 'default');
  const sampler = new HmacOfferPostReviewSampler(secret(1));

  it('draws a stable bucket in 0..9999 for the same Market, Offer and version', () => {
    const first = sampler.bucketOf(au, offer(1), 3);
    expect(Number.isInteger(first)).toBe(true);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(SAMPLE_BUCKETS);
    expect(sampler.bucketOf(au, offer(1), 3)).toBe(first);
    expect(new HmacOfferPostReviewSampler(secret(1)).bucketOf(au, offer(1), 3)).toBe(first);
  });

  it('keys the draw on an HKDF key of its own, never the raw secret or the rate-counter key', () => {
    const message = JSON.stringify(['offer-review-sample', 'AU', offer(1), 3]);
    const derived = hkdfSync(
      'sha256',
      secret(1),
      new Uint8Array(0),
      'catalog.offer-review-sampling',
      32,
    );
    const expected = sampleBucketOf(
      createHmac('sha256', Buffer.from(derived)).update(message).digest(),
    );
    expect(sampler.bucketOf(au, offer(1), 3)).toBe(expected);
    const rateKey = new HmacRateCounterKeys(secret(1)).keyOf(au, 'draft-save.account.minute', 'a');
    expect(Buffer.from(derived)).not.toEqual(Buffer.from(rateKey));
  });

  it('separates Markets, Offers, versions and secrets', () => {
    // Over many Offers, the draws of another Market, version or secret are not the same draws.
    const draws = (fn: (n: number) => number) => Array.from({ length: 64 }, (_, n) => fn(n));
    const base = draws((n) => sampler.bucketOf(au, offer(n), 1));
    expect(draws((n) => sampler.bucketOf(zz, offer(n), 1))).not.toEqual(base);
    expect(draws((n) => sampler.bucketOf(au, offer(n), 2))).not.toEqual(base);
    expect(
      draws((n) => new HmacOfferPostReviewSampler(secret(2)).bucketOf(au, offer(n), 1)),
    ).not.toEqual(base);
  });

  it('samples near the percent over many Offers (uniform enough)', () => {
    const total = 20_000;
    let drawn = 0;
    for (let n = 0; n < total; n += 1) {
      if (isSampled(sampler.bucketOf(au, offer(n), 1), 5)) drawn += 1;
    }
    // 5% of 20,000 is 1,000; sigma is about 31.
    expect(drawn).toBeGreaterThan(850);
    expect(drawn).toBeLessThan(1150);
  });

  it('refuses an empty Offer id, a bad version and a secret of the wrong size', () => {
    expect(() => sampler.bucketOf(au, '' as Id<'Offer'>, 1)).toThrow(TypeError);
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(() => sampler.bucketOf(au, offer(1), version)).toThrow(TypeError);
    }
    expect(() => new HmacOfferPostReviewSampler(new Uint8Array(16))).toThrow(TypeError);
  });

  it('keeps the key out of its enumerable state', () => {
    expect(JSON.stringify(sampler)).toBe('{}');
    expect(Object.keys(sampler)).toEqual([]);
  });
});
