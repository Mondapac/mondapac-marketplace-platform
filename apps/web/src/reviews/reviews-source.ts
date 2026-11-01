import 'server-only';
import { apiGet } from '../storefront/api.ts';
import {
  productSummaryOf,
  reviewsPageOf,
  type ProductSummary,
  type ReviewsPage,
} from './reviews-model.ts';

// The product page's read of the reviews API (public routes, no session). While reviews are off
// the API answers `reviews.disabled` (404): the page then shows nothing of them. Any other fault
// also shows nothing: the product page never waits for, or fails on, its reviews.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface ProductReviews {
  readonly summary: ProductSummary;
  readonly page: ReviewsPage;
}

/** One page of a product's published reviews, newest first; null when there is none to show. */
export async function loadReviewsPage(
  productId: string,
  options: { readonly stars?: number; readonly cursor?: string } = {},
): Promise<ReviewsPage | null> {
  if (!UUID.test(productId)) return null;
  const query = new URLSearchParams();
  if (options.stars !== undefined) query.set('stars', String(options.stars));
  if (options.cursor !== undefined) query.set('cursor', options.cursor);
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;
  const read = await apiGet<unknown>(
    `reviews/products/${encodeURIComponent(productId.toLowerCase())}${suffix}`,
  );
  return read.kind === 'ok' ? reviewsPageOf(read.body) : null;
}

/** The summary and the first page of a product's reviews; null when reviews are off or empty. */
export async function loadProductReviews(productId: string): Promise<ProductReviews | null> {
  if (!UUID.test(productId)) return null;
  const [summaryRead, page] = await Promise.all([
    apiGet<unknown>(`reviews/products/${encodeURIComponent(productId.toLowerCase())}/summary`),
    loadReviewsPage(productId),
  ]);
  if (summaryRead.kind !== 'ok' || page === null) return null;
  const summary = productSummaryOf(summaryRead.body);
  return summary === null || !summary.shown || summary.count === 0 ? null : { summary, page };
}
