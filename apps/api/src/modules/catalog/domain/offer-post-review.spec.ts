import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import {
  OfferPostReview,
  SAMPLE_BUCKETS,
  effectiveSamplingPercent,
  isSampled,
  sampleBucketOf,
  samplingPercentOf,
} from './offer-post-review';

// The post-publication review row and the sample's arithmetic (risk-based Offer approval slice 6).
// Market-agnostic: both fixtures run the same rules.
const MARKETS = ['AU', 'ZZ'] as const;
const T0 = Temporal.Instant.from('2026-11-25T09:00:00Z');
const ID = '01990000-0000-7000-8000-0000000f0001' as Id<'OfferPostReview'>;
const OFFER = '01990000-0000-7000-8000-0000000e0001' as Id<'Offer'>;
const SELLER = '01990000-0000-7000-8000-00000000c001' as Id<'Seller'>;
const PRODUCT = '01990000-0000-7000-8000-00000000d001' as Id<'Product'>;
const ADMIN = '01990000-0000-7000-8000-0000000a0001' as Id<'Account'>;

describe('sampling arithmetic', () => {
  it('scales the first four bytes, big-endian, to 0..9999', () => {
    expect(sampleBucketOf(new Uint8Array([0, 0, 0, 0]))).toBe(0);
    expect(sampleBucketOf(new Uint8Array([0xff, 0xff, 0xff, 0xff, 9]))).toBe(SAMPLE_BUCKETS - 1);
    expect(sampleBucketOf(new Uint8Array([0x80, 0, 0, 0]))).toBe(5000);
    // floor(u32 * 10000 / 2^32): the last u32 of bucket 0 and the first of bucket 1.
    expect(sampleBucketOf(new Uint8Array([0x00, 0x06, 0x8d, 0xb8]))).toBe(0);
    expect(sampleBucketOf(new Uint8Array([0x00, 0x06, 0x8d, 0xb9]))).toBe(1);
    expect(() => sampleBucketOf(new Uint8Array([1, 2, 3]))).toThrow(RangeError);
  });

  it('samples under percent * 100: 0% never, 100% always, the boundary excluded', () => {
    for (const bucket of [0, 1, 4999, 9999]) {
      expect(isSampled(bucket, 0)).toBe(false);
      expect(isSampled(bucket, 100)).toBe(true);
    }
    expect(isSampled(499, 5)).toBe(true);
    expect(isSampled(500, 5)).toBe(false);
    expect(() => isSampled(SAMPLE_BUCKETS, 5)).toThrow(RangeError);
    expect(() => isSampled(-1, 5)).toThrow(RangeError);
    expect(() => isSampled(1.5, 5)).toThrow(RangeError);
  });

  it('reads an odd percent as the safe 100 (fail closed)', () => {
    expect(samplingPercentOf(0)).toBe(0);
    expect(samplingPercentOf(37)).toBe(37);
    for (const odd of [-1, 101, 2.5, '5', null, undefined, Number.NaN]) {
      expect(samplingPercentOf(odd)).toBe(100);
    }
    // An odd percent passed straight to the draw samples every bucket.
    expect(isSampled(9999, Number.NaN)).toBe(true);
  });

  describe('doubling for 30 days after Trusted', () => {
    const now = T0;
    it('doubles while the seller became Trusted less than 720 hours ago, at most 100', () => {
      const since = now.subtract({ hours: 719 });
      expect(effectiveSamplingPercent({ percent: 5, trustedSince: since, now })).toEqual({
        percent: 10,
        doubled: true,
      });
      expect(effectiveSamplingPercent({ percent: 60, trustedSince: since, now })).toEqual({
        percent: 100,
        doubled: true,
      });
    });

    it('stops doubling at exactly 720 hours', () => {
      const since = now.subtract({ hours: 720 });
      expect(effectiveSamplingPercent({ percent: 5, trustedSince: since, now })).toEqual({
        percent: 5,
        doubled: false,
      });
      expect(
        effectiveSamplingPercent({
          percent: 5,
          trustedSince: since.add({ nanoseconds: 1 }),
          now,
        }).doubled,
      ).toBe(true);
    });

    it('never doubles without a Trusted instant, at 0 or at 100', () => {
      expect(effectiveSamplingPercent({ percent: 5, trustedSince: null, now })).toEqual({
        percent: 5,
        doubled: false,
      });
      expect(effectiveSamplingPercent({ percent: 0, trustedSince: now, now })).toEqual({
        percent: 0,
        doubled: false,
      });
      expect(effectiveSamplingPercent({ percent: 100, trustedSince: now, now })).toEqual({
        percent: 100,
        doubled: false,
      });
    });

    it('counts a Trusted instant after now (clock skew) as within the 30 days', () => {
      expect(
        effectiveSamplingPercent({ percent: 5, trustedSince: now.add({ hours: 1 }), now }).doubled,
      ).toBe(true);
    });

    it('reads an odd percent as the safe 100', () => {
      expect(effectiveSamplingPercent({ percent: -3, trustedSince: null, now }).percent).toBe(100);
    });
  });
});

describe.each(MARKETS)('OfferPostReview in market %s', (code) => {
  const marketId = code as MarketId;
  const open = (
    reason: Parameters<typeof OfferPostReview.open>[0]['reason'] = 'price-no-reference',
    sample: { percent: number; doubled: boolean } | null = null,
  ) => {
    const opened = OfferPostReview.open({
      id: ID,
      marketId,
      offerId: OFFER,
      sellerId: SELLER,
      productId: PRODUCT,
      reason,
      sample,
      now: T0,
    });
    if (!opened.ok) throw new Error(opened.error.code);
    return opened.value;
  };

  it('opens at version 1 with its first reason, new and unchanged', () => {
    const review = open();
    expect(review.state).toMatchObject({
      marketId: code,
      status: 'open',
      reasons: ['price-no-reference'],
      samplePercent: null,
      sampleDoubled: false,
      openedAt: T0,
      updatedAt: T0,
      decidedAt: null,
      note: null,
      version: 1,
    });
    expect([review.isNew, review.changed, review.loadedVersion]).toEqual([true, false, 1]);
  });

  it('opens a sample with its figures, and refuses figures that do not fit the reason', () => {
    expect(open('sample', { percent: 10, doubled: true }).state).toMatchObject({
      reasons: ['sample'],
      samplePercent: 10,
      sampleDoubled: true,
    });
    const base = {
      id: ID,
      marketId,
      offerId: OFFER,
      sellerId: SELLER,
      productId: PRODUCT,
      now: T0,
    };
    for (const bad of [
      { reason: 'sample' as const, sample: null },
      { reason: 'sample' as const, sample: { percent: 0, doubled: false } },
      { reason: 'sample' as const, sample: { percent: 101, doubled: false } },
      { reason: 'price-no-reference' as const, sample: { percent: 5, doubled: false } },
      { reason: 'bogus' as never, sample: null },
    ]) {
      expect(OfferPostReview.open({ ...base, ...bad })).toEqual({
        ok: false,
        error: { code: 'post-review.invalid' },
      });
    }
  });

  it('gains each reason once while open, one version per change', () => {
    const review = OfferPostReview.restore(open().state);
    const later = T0.add({ minutes: 5 });
    expect(
      review.addReason({ reason: 'sample', sample: { percent: 5, doubled: false }, now: later }),
    ).toEqual({ ok: true, value: true });
    expect(review.state).toMatchObject({
      reasons: ['price-no-reference', 'sample'],
      samplePercent: 5,
      updatedAt: later,
      version: 2,
    });
    expect(review.addReason({ reason: 'price-no-reference', now: later })).toEqual({
      ok: true,
      value: false,
    });
    expect(review.state.version).toBe(2);
    expect(review.changed).toBe(true);
  });

  it('approves with an optional note; decided once', () => {
    const review = OfferPostReview.restore(open().state);
    expect(review.approve({ accountId: ADMIN, now: T0.add({ hours: 1 }) }).ok).toBe(true);
    expect(review.state).toMatchObject({
      status: 'approved',
      decidedByAccountId: ADMIN,
      decisionReasonCode: null,
      misconduct: null,
      note: null,
      version: 2,
    });
    expect(review.approve({ accountId: ADMIN, now: T0 })).toEqual({
      ok: false,
      error: { code: 'post-review.not-open' },
    });
    expect(
      review.addReason({ reason: 'sample', sample: { percent: 5, doubled: false }, now: T0 }),
    ).toEqual({ ok: false, error: { code: 'post-review.not-open' } });
  });

  it('takes down with a reason code, the misconduct flag and a required note', () => {
    const review = open();
    expect(
      review.takeDown({
        accountId: ADMIN,
        reasonCode: 'description-claim',
        misconduct: true,
        note: 'Claims a certificate it has not got',
        now: T0.add({ hours: 2 }),
      }).ok,
    ).toBe(true);
    expect(review.state).toMatchObject({
      status: 'taken-down',
      decisionReasonCode: 'description-claim',
      misconduct: true,
      note: 'Claims a certificate it has not got',
      decidedAt: T0.add({ hours: 2 }),
    });
  });

  it('refuses a blank or too long note, an unknown reason and a non-boolean misconduct', () => {
    const take = (patch: Record<string, unknown>) =>
      open().takeDown({
        accountId: ADMIN,
        reasonCode: 'other',
        misconduct: false,
        note: 'ok',
        now: T0,
        ...patch,
      } as never);
    expect(take({ note: '   ' })).toEqual({
      ok: false,
      error: { code: 'post-review.note-invalid' },
    });
    expect(take({ note: 'x'.repeat(2001) })).toEqual({
      ok: false,
      error: { code: 'post-review.note-invalid' },
    });
    expect(take({ note: 'x'.repeat(2000) }).ok).toBe(true);
    expect(take({ reasonCode: 'bogus' })).toEqual({
      ok: false,
      error: { code: 'post-review.invalid' },
    });
    expect(take({ misconduct: 'yes' })).toEqual({
      ok: false,
      error: { code: 'post-review.invalid' },
    });
    expect(open().approve({ accountId: ADMIN, note: '', now: T0 })).toEqual({
      ok: false,
      error: { code: 'post-review.note-invalid' },
    });
  });

  it('never decides before the row was last changed (the times check)', () => {
    const review = open();
    review.approve({ accountId: ADMIN, now: T0.subtract({ hours: 1 }) });
    expect(review.state.decidedAt).toEqual(T0);
  });
});
