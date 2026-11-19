import type { Id, Temporal } from '@mondapac/shared-kernel';

// The seller's review list as a super list (phase 3, list 32; CLAUDE.md rule 14): the shop's own
// published reviews with views, filters, sort, page numbers or Previous/Next, the view counts, the
// row Actions menu and the export. It only reads; a reply or a report runs through its own use
// case with its own key. A seller never sees the buyer: nothing here carries a name or an account.

/** The views (tabs): every review, the ones still without a reply, the answered ones, low stars. */
export const SELLER_REVIEW_VIEWS = ['all', 'unanswered', 'answered', 'low'] as const;
export type SellerReviewView_ = (typeof SELLER_REVIEW_VIEWS)[number];

export const SELLER_REVIEW_SORT_KEYS = ['published', 'rating'] as const;
export type SellerReviewSortKey = (typeof SELLER_REVIEW_SORT_KEYS)[number];

export interface SellerReviewSort {
  readonly key: SellerReviewSortKey;
  readonly direction: 'asc' | 'desc';
}

/** The stars at or below which the `low` view lists a review. */
export const LOW_RATING_MAX = 2;

/** Every field is an AND; null leaves it out. */
export interface SellerReviewFilter {
  /** `none`: no published reply; `published`: the shop has replied. */
  readonly reply: 'none' | 'published' | null;
  readonly minRating: number | null;
  readonly maxRating: number | null;
  /** Plain text matched inside the title or the body, case-insensitive. */
  readonly text: string | null;
  /** An id the shop pasted: the review's, its order's, its Offer's or its product's, exact. */
  readonly anyId: string | null;
  /** Published at or after `from`, before `to`. */
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant | null;
}

export const EMPTY_SELLER_REVIEW_FILTER: SellerReviewFilter = Object.freeze({
  reply: null,
  minRating: null,
  maxRating: null,
  text: null,
  anyId: null,
  from: null,
  to: null,
});

/** The count of each view for the shop, whatever the filter. */
export type SellerReviewViewCounts = Readonly<Record<SellerReviewView_, number>>;

export const SELLER_REVIEW_ROW_ACTIONS = ['open', 'reply', 'edit-reply', 'report'] as const;
export type SellerReviewRowAction = (typeof SELLER_REVIEW_ROW_ACTIONS)[number];

/** The columns an export may add, in the order the panel's column picker lists them. */
export const SELLER_REVIEW_EXPORT_COLUMNS = [
  'review-id',
  'order-ref',
  'product-id',
  'offer-id',
  'locale',
  'reply',
  'replied',
] as const;
export type SellerReviewExportColumn = (typeof SELLER_REVIEW_EXPORT_COLUMNS)[number];

/** The view's filter: a view is a shortcut for one reply state or the low stars. */
export function sellerReviewViewFilter(
  view: SellerReviewView_,
): Pick<SellerReviewFilter, 'reply' | 'maxRating'> {
  switch (view) {
    case 'all':
      return { reply: null, maxRating: null };
    case 'unanswered':
      return { reply: 'none', maxRating: null };
    case 'answered':
      return { reply: 'published', maxRating: null };
    case 'low':
      return { reply: null, maxRating: LOW_RATING_MAX };
  }
}

/** The minimum of what {@link sellerReviewMatches} reads of a published review. */
export interface SellerReviewSubject {
  readonly id: Id<'ProductReview'>;
  readonly productId: Id<'Product'>;
  readonly offerId: Id<'Offer'>;
  readonly orderRef: Id<'SellerOrder'> | null;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly publishedAt: Temporal.Instant | null;
  readonly hasReply: boolean;
}

/** Whether a review meets a filter; the in-memory twin of the repository's `where`. */
export function sellerReviewMatches(
  review: SellerReviewSubject,
  filter: SellerReviewFilter,
): boolean {
  if (filter.reply === 'none' && review.hasReply) return false;
  if (filter.reply === 'published' && !review.hasReply) return false;
  if (filter.minRating !== null && review.rating < filter.minRating) return false;
  if (filter.maxRating !== null && review.rating > filter.maxRating) return false;
  if (filter.text !== null) {
    const needle = filter.text.toLowerCase();
    const hay = `${review.title ?? ''}\n${review.body ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  if (
    filter.anyId !== null &&
    review.id !== filter.anyId &&
    review.orderRef !== filter.anyId &&
    review.offerId !== filter.anyId &&
    review.productId !== filter.anyId
  ) {
    return false;
  }
  const at = review.publishedAt?.epochMilliseconds ?? 0;
  if (filter.from !== null && at < filter.from.epochMilliseconds) return false;
  if (filter.to !== null && at >= filter.to.epochMilliseconds) return false;
  return true;
}

/** Sorts two reviews; the review id breaks every tie, so a page boundary never repeats a row. */
export function compareSellerReviews(
  a: SellerReviewSubject,
  b: SellerReviewSubject,
  sort: SellerReviewSort,
): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  const primary =
    sort.key === 'published'
      ? (a.publishedAt?.epochMilliseconds ?? 0) - (b.publishedAt?.epochMilliseconds ?? 0)
      : a.rating - b.rating;
  if (primary !== 0) return sign * primary;
  return sign * (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
