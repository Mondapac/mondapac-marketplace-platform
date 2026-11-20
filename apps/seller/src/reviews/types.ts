// Answers of the seller review routes (apps/api seller-reviews.controller.ts). A seller sees its
// own published reviews and an order reference; never the buyer's name, email or address.

export const REVIEWS_VIEW_PERMISSION = 'reviews.seller.view';
export const REVIEWS_REPLY_PERMISSION = 'reviews.seller.reply';
export const REVIEWS_REPORT_PERMISSION = 'reviews.seller.report';

/** The closed list of reasons a seller may give when it reports a review. */
export const REPORT_REASONS = [
  'personal-information',
  'abusive',
  'irrelevant',
  'not-a-purchase',
  'extortion',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface SellerReply {
  readonly body: string;
  readonly createdAt: string;
  readonly editedAt: string | null;
  /** After this instant the reply can no longer be edited. */
  readonly editableUntil: string;
}

export interface SellerReview {
  readonly id: string;
  readonly productId: string;
  readonly offerId: string;
  /** The seller order of the purchase, or null when the order link is gone. */
  readonly orderRef: string | null;
  readonly rating: number;
  readonly title: string | null;
  readonly body: string | null;
  readonly locale: string;
  readonly publishedAt: string | null;
  readonly reply: SellerReply | null;
}

export interface SellerReviewPage {
  readonly items: readonly SellerReview[];
  readonly nextCursor: string | null;
}

/** The actions the API names for a row of the list (the server decides per caller and review). */
export type ReviewRowAction = 'open' | 'reply' | 'edit-reply' | 'report';

export interface SellerReviewRow extends SellerReview {
  readonly actions: readonly ReviewRowAction[];
}

export interface ReviewListCounts {
  readonly all: number;
  readonly unanswered: number;
  readonly answered: number;
  readonly low: number;
}

/** The answer of GET reviews/seller/list. `total` is null with Previous and next. */
export interface ReviewListPage {
  readonly items: readonly SellerReviewRow[];
  readonly counts: ReviewListCounts;
  readonly total: number | null;
  readonly page: number;
  readonly pageSize: number;
  readonly paging: 'pages' | 'prev-next';
  readonly hasNext: boolean;
}
