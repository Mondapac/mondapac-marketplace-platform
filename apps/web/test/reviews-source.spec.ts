import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiRead } from '../src/storefront/api.ts';
import { loadProductReviews, loadReviewsPage } from '../src/reviews/reviews-source.ts';

// The product page's read of the reviews API: which routes it asks, and that every refusal,
// the Market's switch being off among them, leaves the page without a reviews section.

const reads = vi.hoisted(() => ({
  answers: new Map<string, ApiRead<unknown>>(),
  paths: [] as string[],
}));
vi.mock('../src/storefront/api.ts', () => ({
  apiGet: (path: string) => {
    reads.paths.push(path);
    return Promise.resolve(reads.answers.get(path) ?? { kind: 'failed' });
  },
}));

const PRODUCT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const REVIEW = 'aaaaaaaa-2222-4333-8444-555555555555';
const OFFER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SELLER = '886313e1-3b8a-5372-9b90-0c9aee199e5d';
const LIST = `reviews/products/${PRODUCT}`;
const page = {
  reviews: [
    {
      id: REVIEW,
      rating: 5,
      title: null,
      body: null,
      locale: 'en',
      author: { kind: 'verified-buyer' },
      boughtFrom: { offerId: OFFER, sellerId: SELLER },
      publishedOn: '2026-10-12',
      editedOn: null,
    },
  ],
  nextCursor: null,
};
const summary = (extra: object = {}) => ({
  productId: PRODUCT,
  count: 1,
  averageTimes100: 500,
  histogram: [0, 0, 0, 0, 1],
  shown: true,
  ...extra,
});

beforeEach(() => {
  reads.answers.clear();
  reads.paths.length = 0;
});

describe('loadProductReviews', () => {
  it('reads the summary and the first page', async () => {
    reads.answers.set(`${LIST}/summary`, { kind: 'ok', body: summary() });
    reads.answers.set(LIST, { kind: 'ok', body: page });
    const found = await loadProductReviews(PRODUCT);
    expect(found?.summary.count).toBe(1);
    expect(found?.page.reviews).toHaveLength(1);
  });

  it('shows nothing while reviews are off, on a fault, or without a review', async () => {
    reads.answers.set(`${LIST}/summary`, {
      kind: 'failed',
      status: 404,
      code: 'reviews.disabled',
    });
    reads.answers.set(LIST, { kind: 'failed', status: 404, code: 'reviews.disabled' });
    expect(await loadProductReviews(PRODUCT)).toBeNull();

    reads.answers.set(`${LIST}/summary`, { kind: 'ok', body: summary({ count: 0, shown: false }) });
    reads.answers.set(LIST, { kind: 'ok', body: { reviews: [], nextCursor: null } });
    expect(await loadProductReviews(PRODUCT)).toBeNull();
  });

  it('asks nothing for a sample product id', async () => {
    expect(await loadProductReviews('lamb-mince')).toBeNull();
    expect(reads.paths).toEqual([]);
  });
});

describe('loadReviewsPage', () => {
  it('passes the star filter and the cursor in the query', async () => {
    reads.answers.set(`${LIST}?stars=2&cursor=${REVIEW}`, { kind: 'ok', body: page });
    const read = await loadReviewsPage(PRODUCT, { stars: 2, cursor: REVIEW });
    expect(read.kind === 'ok' && read.page.reviews).toHaveLength(1);
  });
  it('tells a body that is not a page, a throttle, a fault and "off" apart', async () => {
    reads.answers.set(LIST, { kind: 'ok', body: { reviews: 'no' } });
    expect(await loadReviewsPage(PRODUCT)).toEqual({ kind: 'failed' });
    reads.answers.set(LIST, { kind: 'failed', status: 429 });
    expect(await loadReviewsPage(PRODUCT)).toEqual({ kind: 'throttled' });
    reads.answers.set(LIST, { kind: 'failed', status: 503, code: 'reviews.unavailable' });
    expect(await loadReviewsPage(PRODUCT)).toEqual({ kind: 'failed' });
    reads.answers.set(LIST, { kind: 'failed', status: 404, code: 'reviews.disabled' });
    expect(await loadReviewsPage(PRODUCT)).toEqual({ kind: 'off' });
  });
});
