import { call, isRecord, type ApiResult } from '../account/customer-api.ts';
import {
  myReviewsOf,
  ownReviewOf,
  reviewsPageOf,
  toReviewOf,
  type MyReviews,
  type OwnReview,
  type ReviewsPage,
  type ToReview,
} from './reviews-model.ts';

// The buyer's review calls, made from the browser through the same-origin relay (live mode). The
// text of a review goes only in a request body; nothing here logs it.

/** What the buyer's form sends for a review. */
export interface ReviewInput {
  readonly rating: number;
  readonly title: string;
  readonly body: string;
  readonly anonymous: boolean;
}

/** An empty field is left out of a new review and cleared on an edit. */
const trimmed = (value: string): string => value.trim();

/** `GET reviews/me/to-review`: what is delivered, inside the window and not yet reviewed. */
export function readToReview(): Promise<ApiResult<ToReview>> {
  return call('GET', 'reviews/me/to-review', undefined, (json) => toReviewOf(json) ?? undefined);
}

/** `GET reviews/me`: the buyer's own reviews and seller ratings. */
export function readMyReviews(): Promise<ApiResult<MyReviews>> {
  return call('GET', 'reviews/me', undefined, (json) => myReviewsOf(json) ?? undefined);
}

export interface SubmittedReview {
  /** `purchase-recorded`: the product was reviewed before; only the "bought from" moved. */
  readonly outcome: 'created' | 'resubmitted' | 'purchase-recorded';
  readonly review: OwnReview;
}

/** `POST reviews/products`. */
export function submitReview(
  productId: string,
  input: ReviewInput,
): Promise<ApiResult<SubmittedReview>> {
  const title = trimmed(input.title);
  const body = trimmed(input.body);
  return call(
    'POST',
    'reviews/products',
    {
      productId,
      rating: input.rating,
      ...(title === '' ? {} : { title }),
      ...(body === '' ? {} : { body }),
      anonymous: input.anonymous,
    },
    (json) => {
      const review = ownReviewOf(json.review);
      const outcome = json.outcome;
      if (review === null) return undefined;
      if (outcome !== 'created' && outcome !== 'resubmitted' && outcome !== 'purchase-recorded') {
        return undefined;
      }
      return { outcome, review };
    },
  );
}

/** `PATCH reviews/products/:id`: the author edits their review. */
export function editReview(id: string, input: ReviewInput): Promise<ApiResult<OwnReview>> {
  const title = trimmed(input.title);
  const body = trimmed(input.body);
  return call(
    'PATCH',
    `reviews/products/${encodeURIComponent(id)}`,
    {
      rating: input.rating,
      title: title === '' ? null : title,
      body: body === '' ? null : body,
      anonymous: input.anonymous,
    },
    (json) => ownReviewOf(json) ?? undefined,
  );
}

/** `DELETE reviews/products/:id`: the author deletes their review. */
export function deleteReview(id: string): Promise<ApiResult<true>> {
  return call('DELETE', `reviews/products/${encodeURIComponent(id)}`, undefined, (json) =>
    isRecord(json) && json.status === 'deleted-by-author' ? true : undefined,
  );
}

export const REASONS = ['damaged', 'missing-items', 'temperature', 'other'] as const;
export type ArrivalReason = (typeof REASONS)[number];

export interface SellerRatingInput {
  readonly satisfaction: number;
  readonly asDescribed: boolean;
  readonly arrivedOk: boolean;
  readonly reasonCode: ArrivalReason | null;
}

/** `POST reviews/seller-orders/:id/rating`. */
export function rateSellerOrder(
  sellerOrderId: string,
  input: SellerRatingInput,
): Promise<ApiResult<true>> {
  return call(
    'POST',
    `reviews/seller-orders/${encodeURIComponent(sellerOrderId)}/rating`,
    {
      satisfaction: input.satisfaction,
      asDescribed: input.asDescribed,
      arrivedOk: input.arrivedOk,
      // The reason is asked only when the order did not arrive well.
      ...(input.arrivedOk || input.reasonCode === null ? {} : { reasonCode: input.reasonCode }),
    },
    (json) => (isRecord(json) ? true : undefined),
  );
}

/** One page of a product's published reviews through the site's own route (anonymous). */
export async function readReviewsPage(
  productId: string,
  options: { readonly stars?: number; readonly cursor?: string },
): Promise<ReviewsPage | null> {
  const query = new URLSearchParams();
  if (options.stars !== undefined) query.set('stars', String(options.stars));
  if (options.cursor !== undefined) query.set('cursor', options.cursor);
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;
  try {
    const response = await fetch(`/api/product-reviews/${encodeURIComponent(productId)}${suffix}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return reviewsPageOf(await response.json());
  } catch {
    return null;
  }
}
