import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { AuthorLabel } from '../domain/author';
import type { ReviewStatus, SellerRatingReason, SellerRatingStatus } from '../domain/rules';
import { windowEndsAt } from '../domain/rules';
import type { ProductReviewRecord, SellerRatingRecord } from './ports/review.repository';

// What the use cases answer. Ids, codes and the author's own text only; the product name, the
// store name and the author's name are read by the web through catalog, sellers and the label
// below. A review's text is returned to its author and, once published, to the public: never to
// a log, an event or an audit row.

/** A review as its author sees it (any status, with the edit deadline). */
export interface OwnReviewView {
  readonly id: Id<'ProductReview'>;
  readonly productId: Id<'Product'>;
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly locale: string;
  readonly anonymous: boolean;
  /** `held` means it waits for a human; the author is not told why. */
  readonly status: ReviewStatus;
  readonly createdAt: Temporal.Instant;
  readonly editedAt: Temporal.Instant | null;
  readonly publishedAt: Temporal.Instant | null;
  readonly lastPurchaseAt: Temporal.Instant;
  /** After this instant the author can no longer edit (delete stays possible). */
  readonly editableUntil: Temporal.Instant;
}

export function ownReviewView(record: ProductReviewRecord, editWindowDays: number): OwnReviewView {
  return {
    id: record.id,
    productId: record.productId,
    offerId: record.offerId,
    sellerId: record.sellerId,
    rating: record.rating,
    title: record.title,
    body: record.body,
    locale: record.locale,
    anonymous: record.anonymous,
    status: record.status,
    createdAt: record.createdAt,
    editedAt: record.editedAt,
    publishedAt: record.publishedAt,
    lastPurchaseAt: record.lastPurchaseAt,
    editableUntil: windowEndsAt(record.createdAt, editWindowDays),
  };
}

export interface OwnSellerRatingView {
  readonly id: Id<'SellerRating'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly satisfaction: number;
  readonly asDescribed: boolean;
  readonly arrivedOk: boolean;
  readonly reasonCode: SellerRatingReason | null;
  readonly status: SellerRatingStatus;
  readonly createdAt: Temporal.Instant;
}

export const ownSellerRatingView = (record: SellerRatingRecord): OwnSellerRatingView => ({
  id: record.id,
  sellerOrderId: record.sellerOrderId,
  sellerId: record.sellerId,
  satisfaction: record.satisfaction,
  asDescribed: record.asDescribed,
  arrivedOk: record.arrivedOk,
  reasonCode: record.reasonCode,
  status: record.status,
  createdAt: record.createdAt,
});

/** A published review as the public sees it. */
export interface PublicReviewView {
  readonly id: Id<'ProductReview'>;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly locale: string;
  readonly author: AuthorLabel;
  /** The offer and seller of the latest purchase: the "Bought from" label. */
  readonly boughtFrom: { readonly offerId: Id<'Offer'>; readonly sellerId: Id<'Seller'> };
  /** The day only (`YYYY-MM-DD`, UTC): an exact time could link an anonymous review to an order. */
  readonly publishedOn: string;
  readonly editedOn: string | null;
}
