import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import {
  categoryReviewFactsOf,
  CategoryOfferReviewFlags,
  flagReasonOf,
} from './category-offer-review-flags';

const T0 = Temporal.Instant.from('2026-11-25T09:00:00Z');
const CATEGORY = '01990000-0000-7000-8000-00000000ca01' as Id<'Category'>;
const ADMIN = '01990000-0000-7000-8000-00000000b001' as Id<'Account'>;

describe.each(TEST_MARKET_IDS)('CategoryOfferReviewFlags in market %s', (code) => {
  const marketId = code;

  it('starts with both flags off and no row', () => {
    const flags = CategoryOfferReviewFlags.none(marketId, CATEGORY);
    expect(flags.isNew).toBe(true);
    expect(flags.valueOf('always-review')).toBe(false);
    expect(flags.valueOf('review-stop')).toBe(false);
  });

  it('switches one flag with who and when, and leaves the other', () => {
    const flags = CategoryOfferReviewFlags.none(marketId, CATEGORY);
    expect(flags.set({ flag: 'review-stop', on: true, by: ADMIN, now: T0 })).toEqual({
      previous: false,
    });
    expect(flags.state.reviewStop).toEqual({ on: true, changedAt: T0, changedBy: ADMIN });
    expect(flags.state.alwaysReview).toEqual({ on: false, changedAt: null, changedBy: null });
    expect(flags.state.createdAt).toEqual(T0);
  });

  it('answers null for a value it already holds (nothing to write)', () => {
    const flags = CategoryOfferReviewFlags.none(marketId, CATEGORY);
    expect(flags.set({ flag: 'always-review', on: false, by: ADMIN, now: T0 })).toBeNull();
    expect(flags.state.alwaysReview.changedAt).toBeNull();
  });
});

describe('categoryReviewFactsOf', () => {
  const flagged = [
    { categoryId: 'meat', alwaysReview: true, reviewStop: false },
    { categoryId: 'supplements', alwaysReview: false, reviewStop: true },
  ];

  it('applies a flag of the category or any ancestor', () => {
    expect(categoryReviewFactsOf(['food', 'meat', 'lamb'], flagged)).toEqual({
      sensitiveCategory: true,
      emergencyStop: false,
    });
    expect(categoryReviewFactsOf(['health', 'supplements'], flagged)).toEqual({
      sensitiveCategory: false,
      emergencyStop: true,
    });
  });

  it('is off when no category of the product is flagged', () => {
    expect(categoryReviewFactsOf(['home'], flagged)).toEqual({
      sensitiveCategory: false,
      emergencyStop: false,
    });
    expect(categoryReviewFactsOf([], [])).toEqual({
      sensitiveCategory: false,
      emergencyStop: false,
    });
  });
});

describe('flagReasonOf', () => {
  it('trims and keeps 1 to 500 characters', () => {
    expect(flagReasonOf('  legal asked  ')).toEqual({ ok: true, reason: 'legal asked' });
    expect(flagReasonOf('x'.repeat(500))).toMatchObject({ ok: true });
  });

  it('refuses a missing, blank, non-text or too long reason', () => {
    expect(flagReasonOf(undefined)).toEqual({ ok: false, code: 'required' });
    expect(flagReasonOf('   ')).toEqual({ ok: false, code: 'required' });
    expect(flagReasonOf(5)).toEqual({ ok: false, code: 'type' });
    expect(flagReasonOf('x'.repeat(501))).toEqual({ ok: false, code: 'too-long' });
  });
});
