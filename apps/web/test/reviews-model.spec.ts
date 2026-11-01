import { describe, expect, it } from 'vitest';
import {
  averageOf,
  myReviewsOf,
  productSummaryOf,
  reviewsPageOf,
  shareOf,
  toReviewOf,
} from '../src/reviews/reviews-model.ts';

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OFFER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SELLER = '886313e1-3b8a-5372-9b90-0c9aee199e5d';
const review = (extra: object = {}) => ({
  id: ID,
  rating: 4,
  title: 'Fresh',
  body: 'Good.',
  locale: 'en',
  author: { kind: 'named', name: 'Sara K.' },
  boughtFrom: { offerId: OFFER, sellerId: SELLER },
  publishedOn: '2026-10-12',
  editedOn: null,
  ...extra,
});

describe('product summary', () => {
  it('reads the counts and the average', () => {
    expect(
      productSummaryOf({
        productId: ID,
        count: 5,
        averageTimes100: 460,
        histogram: [0, 0, 1, 1, 3],
        shown: true,
      }),
    ).toEqual({ count: 5, averageTimes100: 460, histogram: [0, 0, 1, 1, 3], shown: true });
  });
  it('refuses a body that is not a summary', () => {
    expect(productSummaryOf(null)).toBeNull();
    expect(productSummaryOf({ count: 1, histogram: [1, 0, 0, 0], shown: true })).toBeNull();
    expect(productSummaryOf({ count: -1, histogram: [0, 0, 0, 0, 0], shown: true })).toBeNull();
  });
  it('writes one decimal and whole percents', () => {
    expect(averageOf(460)).toBe('4.6');
    expect(averageOf(433)).toBe('4.3');
    expect(shareOf(1, 3)).toBe(33);
    expect(shareOf(0, 0)).toBe(0);
  });
});

describe('published reviews page', () => {
  it('reads reviews, authors and the cursor', () => {
    const page = reviewsPageOf({
      reviews: [
        review(),
        review({ id: OFFER, author: { kind: 'verified-buyer' } }),
        review({ id: SELLER, author: { kind: 'former-customer' }, title: null, body: null }),
      ],
      nextCursor: SELLER,
    });
    expect(page?.reviews.map((r) => r.author.kind)).toEqual([
      'named',
      'verified-buyer',
      'former-customer',
    ]);
    expect(page?.nextCursor).toBe(SELLER);
  });
  it('shows "Verified buyer" for a named author without a usable name, never an empty name', () => {
    const page = reviewsPageOf({
      reviews: [review({ author: { kind: 'named', name: '   ' } })],
      nextCursor: null,
    });
    expect(page?.reviews[0]?.author).toEqual({ kind: 'verified-buyer' });
  });
  it('refuses a review with a rating outside 1 to 5 or a bad id', () => {
    expect(reviewsPageOf({ reviews: [review({ rating: 6 })], nextCursor: null })).toBeNull();
    expect(reviewsPageOf({ reviews: [review({ id: 'x' })], nextCursor: null })).toBeNull();
    expect(reviewsPageOf({ reviews: [], nextCursor: 'not-an-id' })).toBeNull();
  });
});

describe("the buyer's own reads", () => {
  it('reads what waits for a review', () => {
    const answer = toReviewOf({
      products: [
        {
          productId: ID,
          offerId: OFFER,
          sellerId: SELLER,
          sellerOrderId: ID,
          deliveredAt: '2026-10-01T00:00:00.000Z',
          windowEndsAt: '2026-11-30T00:00:00.000Z',
        },
      ],
      sellerOrders: [],
    });
    expect(answer?.products).toHaveLength(1);
    expect(toReviewOf({ products: [{}], sellerOrders: [] })).toBeNull();
  });
  it('keeps only published seller ratings', () => {
    const own = {
      id: ID,
      productId: ID,
      offerId: OFFER,
      sellerId: SELLER,
      rating: 5,
      title: null,
      body: null,
      anonymous: false,
      status: 'held',
      editableUntil: '2026-11-30T00:00:00.000Z',
    };
    const mine = myReviewsOf({
      reviews: [own],
      sellerRatings: [
        { sellerOrderId: ID, sellerId: SELLER, satisfaction: 4, status: 'published' },
        { sellerOrderId: OFFER, sellerId: SELLER, satisfaction: 1, status: 'hidden' },
      ],
    });
    expect(mine?.reviews[0]?.status).toBe('held');
    expect(mine?.sellerRatings).toHaveLength(1);
  });
});
