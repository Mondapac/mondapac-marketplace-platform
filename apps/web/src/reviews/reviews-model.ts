// What the buyer pages know of the reviews API (reviews package 1; docs/modules/reviews/notes.md).
// Every body is read field by field: an answer that does not have the shape is "no answer", never
// a half-shown review. Pure, for the server page, the browser calls and the tests.

type Json = Readonly<Record<string, unknown>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const INSTANT = /^\d{4}-\d{2}-\d{2}T/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const uuid = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
const instant = (value: unknown): string | null =>
  typeof value === 'string' && INSTANT.test(value) ? value : null;
const day = (value: unknown): string | null =>
  typeof value === 'string' && DAY.test(value) ? value : null;
const stars = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
const orNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The star counts of a product, 1 to 5, and the average. */
export interface ProductSummary {
  readonly count: number;
  /** Hundredths of a star (433 is 4.33); null without a review. */
  readonly averageTimes100: number | null;
  /** Reviews of 1, 2, 3, 4 and 5 stars. */
  readonly histogram: readonly [number, number, number, number, number];
  readonly shown: boolean;
}

export function productSummaryOf(body: unknown): ProductSummary | null {
  if (!isRecord(body)) return null;
  const { count, averageTimes100, histogram, shown } = body;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null;
  if (typeof shown !== 'boolean') return null;
  if (!Array.isArray(histogram) || histogram.length !== 5) return null;
  if (!histogram.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) {
    return null;
  }
  const average =
    typeof averageTimes100 === 'number' && Number.isFinite(averageTimes100)
      ? averageTimes100
      : null;
  return {
    count,
    averageTimes100: average,
    histogram: histogram as unknown as ProductSummary['histogram'],
    shown,
  };
}

/** The name line of a published review's author; a name is shown only when the API sent one. */
export type ReviewAuthor =
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'verified-buyer' }
  | { readonly kind: 'former-customer' };

export interface PublicReview {
  readonly id: string;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly author: ReviewAuthor;
  readonly offerId: string;
  readonly sellerId: string;
  /** The UTC day (ISO date). */
  readonly publishedOn: string;
  readonly editedOn: string | null;
}

export interface ReviewsPage {
  readonly reviews: readonly PublicReview[];
  readonly nextCursor: string | null;
}

function authorOf(value: unknown): ReviewAuthor | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'named') {
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    // A "named" review without a usable name reads as the safe default, never as an empty name.
    return name === '' || name.length > 80 ? { kind: 'verified-buyer' } : { kind: 'named', name };
  }
  if (value.kind === 'verified-buyer' || value.kind === 'former-customer') {
    return { kind: value.kind };
  }
  return null;
}

export function reviewsPageOf(body: unknown): ReviewsPage | null {
  if (!isRecord(body) || !Array.isArray(body.reviews)) return null;
  const reviews: PublicReview[] = [];
  for (const item of body.reviews) {
    if (!isRecord(item) || !isRecord(item.boughtFrom)) return null;
    const id = uuid(item.id);
    const rating = stars(item.rating);
    const author = authorOf(item.author);
    const offerId = uuid(item.boughtFrom.offerId);
    const sellerId = uuid(item.boughtFrom.sellerId);
    const publishedOn = day(item.publishedOn);
    if (id === null || rating === null || author === null) return null;
    if (offerId === null || sellerId === null || publishedOn === null) return null;
    reviews.push({
      id,
      rating,
      title: orNull(item.title),
      body: orNull(item.body),
      author,
      offerId,
      sellerId,
      publishedOn,
      editedOn: day(item.editedOn),
    });
  }
  const next = body.nextCursor;
  if (next !== null && uuid(next) === null) return null;
  return { reviews, nextCursor: next === null ? null : (next as string) };
}

export type OwnReviewStatus = 'published' | 'held' | 'hidden' | 'removed' | 'deleted-by-author';
const OWN_STATUSES: readonly string[] = [
  'published',
  'held',
  'hidden',
  'removed',
  'deleted-by-author',
];

/** A review the buyer wrote, as the buyer sees it. */
export interface OwnReview {
  readonly id: string;
  readonly productId: string;
  readonly offerId: string;
  readonly sellerId: string;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly anonymous: boolean;
  readonly status: OwnReviewStatus;
  readonly editableUntil: string;
}

export function ownReviewOf(value: unknown): OwnReview | null {
  if (!isRecord(value)) return null;
  const id = uuid(value.id);
  const productId = uuid(value.productId);
  const offerId = uuid(value.offerId);
  const sellerId = uuid(value.sellerId);
  const rating = stars(value.rating);
  const until = instant(value.editableUntil);
  const status = typeof value.status === 'string' ? value.status : '';
  if (id === null || productId === null || offerId === null || sellerId === null) return null;
  if (rating === null || until === null || !OWN_STATUSES.includes(status)) return null;
  if (typeof value.anonymous !== 'boolean') return null;
  return {
    id,
    productId,
    offerId,
    sellerId,
    rating,
    title: orNull(value.title),
    body: orNull(value.body),
    anonymous: value.anonymous,
    status: status as OwnReviewStatus,
    editableUntil: until,
  };
}

export interface OwnSellerRating {
  readonly sellerOrderId: string;
  readonly sellerId: string;
  readonly satisfaction: number;
}

export interface MyReviews {
  readonly reviews: readonly OwnReview[];
  readonly sellerRatings: readonly OwnSellerRating[];
}

export function myReviewsOf(body: unknown): MyReviews | null {
  if (!isRecord(body) || !Array.isArray(body.reviews) || !Array.isArray(body.sellerRatings)) {
    return null;
  }
  const reviews = body.reviews.map(ownReviewOf);
  if (reviews.some((review) => review === null)) return null;
  const sellerRatings: OwnSellerRating[] = [];
  for (const item of body.sellerRatings) {
    if (!isRecord(item)) return null;
    const sellerOrderId = uuid(item.sellerOrderId);
    const sellerId = uuid(item.sellerId);
    const satisfaction = stars(item.satisfaction);
    if (sellerOrderId === null || sellerId === null || satisfaction === null) return null;
    // A rating a moderator took down is not shown as the buyer's current rating.
    if (item.status === 'published') sellerRatings.push({ sellerOrderId, sellerId, satisfaction });
  }
  return { reviews: reviews as OwnReview[], sellerRatings };
}

export interface ToReviewProduct {
  readonly productId: string;
  readonly offerId: string;
  readonly sellerId: string;
  readonly sellerOrderId: string;
  readonly windowEndsAt: string;
}
export interface ToReviewSellerOrder {
  readonly sellerOrderId: string;
  readonly sellerId: string;
  readonly deliveredAt: string;
  readonly windowEndsAt: string;
}
export interface ToReview {
  readonly products: readonly ToReviewProduct[];
  readonly sellerOrders: readonly ToReviewSellerOrder[];
}

export function toReviewOf(body: unknown): ToReview | null {
  if (!isRecord(body) || !Array.isArray(body.products) || !Array.isArray(body.sellerOrders)) {
    return null;
  }
  const products: ToReviewProduct[] = [];
  for (const item of body.products) {
    if (!isRecord(item)) return null;
    const productId = uuid(item.productId);
    const offerId = uuid(item.offerId);
    const sellerId = uuid(item.sellerId);
    const sellerOrderId = uuid(item.sellerOrderId);
    const windowEndsAt = instant(item.windowEndsAt);
    if (productId === null || offerId === null || sellerId === null) return null;
    if (sellerOrderId === null || windowEndsAt === null) return null;
    products.push({ productId, offerId, sellerId, sellerOrderId, windowEndsAt });
  }
  const sellerOrders: ToReviewSellerOrder[] = [];
  for (const item of body.sellerOrders) {
    if (!isRecord(item)) return null;
    const sellerOrderId = uuid(item.sellerOrderId);
    const sellerId = uuid(item.sellerId);
    const deliveredAt = instant(item.deliveredAt);
    const windowEndsAt = instant(item.windowEndsAt);
    if (sellerOrderId === null || sellerId === null) return null;
    if (deliveredAt === null || windowEndsAt === null) return null;
    sellerOrders.push({ sellerOrderId, sellerId, deliveredAt, windowEndsAt });
  }
  return { products, sellerOrders };
}

/** The average as the page writes it: one decimal, "4.6". */
export const averageOf = (times100: number): string => (times100 / 100).toFixed(1);

/** The share of one star row, in whole percent of all reviews. */
export function shareOf(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 100);
}
