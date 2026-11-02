import { ApiProperty } from '@nestjs/swagger';
import { REVIEWS_STATUSES } from '../domain/market-status';
import { REVIEW_STATUSES, SELLER_RATING_REASONS } from '../domain/rules';
import { MODERATOR_ACTIONS, QUEUE_TABS } from '../domain/moderation';
import type {
  ModerationQueuePage,
  ModerationReviewView,
} from '../application/use-cases/list-moderation-queue.use-case';
import type { ModerationDetailView } from '../application/use-cases/view-moderation-review.use-case';
import type { ProductRatingSummary, SellerRatingSummary } from '../contracts';
import type { MyReviewsView } from '../application/use-cases/list-my-reviews.use-case';
import type { ProductReviewsPage } from '../application/use-cases/list-product-reviews.use-case';
import type { ToReviewView } from '../application/use-cases/list-to-review.use-case';
import type { SubmittedReview } from '../application/use-cases/submit-product-review.use-case';
import type { SettingsView } from '../application/use-cases/view-reviews-settings.use-case';
import type {
  OwnReviewView,
  PublicReviewView,
} from '../application/use-cases/edit-product-review.use-case';
import type { OwnSellerRatingView } from '../application/use-cases/rate-seller-order.use-case';

// Bodies of the reviews routes. Ids, codes, counts and the author's own text; instants are ISO
// strings. A review's text appears only in the author's own answers and in published reviews.

export class OwnReviewBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ format: 'uuid', description: 'The offer of the latest purchase.' })
  offerId!: string;
  @ApiProperty({ format: 'uuid', description: 'The seller of the latest purchase.' })
  sellerId!: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) rating!: number;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ nullable: true, type: String }) body!: string | null;
  @ApiProperty() locale!: string;
  @ApiProperty() anonymous!: boolean;
  @ApiProperty({
    enum: [...REVIEW_STATUSES],
    description: '`held` waits for a human; the reason is not shown.',
  })
  status!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) editedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) publishedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) lastPurchaseAt!: string;
  @ApiProperty({
    format: 'date-time',
    description: 'After this instant the review can no longer be edited.',
  })
  editableUntil!: string;
}

export class SubmittedReviewBody {
  @ApiProperty({ enum: ['created', 'resubmitted', 'purchase-recorded'] }) outcome!: string;
  @ApiProperty({ type: OwnReviewBody }) review!: OwnReviewBody;
}

export class OwnSellerRatingBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) sellerOrderId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) satisfaction!: number;
  @ApiProperty() asDescribed!: boolean;
  @ApiProperty() arrivedOk!: boolean;
  @ApiProperty({ enum: [...SELLER_RATING_REASONS], nullable: true, type: String })
  reasonCode!: string | null;
  @ApiProperty({ enum: ['published', 'hidden', 'removed'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

class ToReviewProductBody {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ format: 'uuid' }) sellerOrderId!: string;
  @ApiProperty({ format: 'date-time' }) deliveredAt!: string;
  @ApiProperty({ format: 'date-time' }) windowEndsAt!: string;
}

class ToReviewSellerOrderBody {
  @ApiProperty({ format: 'uuid' }) sellerOrderId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ format: 'date-time' }) deliveredAt!: string;
  @ApiProperty({ format: 'date-time' }) windowEndsAt!: string;
}

export class ToReviewBody {
  @ApiProperty({
    type: [ToReviewProductBody],
    description: 'Delivered, inside the window, not reviewed yet.',
  })
  products!: ToReviewProductBody[];
  @ApiProperty({
    type: [ToReviewSellerOrderBody],
    description: 'Delivered, inside the window, not rated yet.',
  })
  sellerOrders!: ToReviewSellerOrderBody[];
}

export class MyReviewsBody {
  @ApiProperty({ type: [OwnReviewBody] }) reviews!: OwnReviewBody[];
  @ApiProperty({ type: [OwnSellerRatingBody] }) sellerRatings!: OwnSellerRatingBody[];
}

class AuthorBody {
  @ApiProperty({
    enum: ['named', 'verified-buyer', 'former-customer'],
    description: '`named` carries the short name read now; the others carry none.',
  })
  kind!: string;
  @ApiProperty({ required: false, type: String }) name?: string;
}

class BoughtFromBody {
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
}

export class PublicReviewBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) rating!: number;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ nullable: true, type: String }) body!: string | null;
  @ApiProperty() locale!: string;
  @ApiProperty({ type: AuthorBody }) author!: AuthorBody;
  @ApiProperty({ type: BoughtFromBody }) boughtFrom!: BoughtFromBody;
  @ApiProperty({ format: 'date', description: 'The day only (UTC).' }) publishedOn!: string;
  @ApiProperty({ format: 'date', nullable: true, type: String }) editedOn!: string | null;
}

export class ProductReviewsBody {
  @ApiProperty({ type: [PublicReviewBody], description: 'Published reviews, newest first.' })
  reviews!: PublicReviewBody[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class ProductSummaryBody {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty() count!: number;
  @ApiProperty({ nullable: true, type: Number, description: 'Hundredths of a star; 433 is 4.33.' })
  averageTimes100!: number | null;
  @ApiProperty({ type: [Number], description: 'Reviews of 1, 2, 3, 4 and 5 stars.' })
  histogram!: number[];
  @ApiProperty({ description: 'True from the first review.' }) shown!: boolean;
}

export class SellerSummaryBody {
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ description: 'Rated seller orders.' }) count!: number;
  @ApiProperty({ description: "The Market's minimum before the summary is meant to be shown." })
  minimumCount!: number;
  @ApiProperty() meetsMinimum!: boolean;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Null until the seller has the Market minimum of rated seller orders.',
  })
  averageTimes100!: number | null;
  @ApiProperty({ nullable: true, type: [Number], description: 'Null below the minimum.' })
  histogram!: number[] | null;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Basis points; null below the minimum.',
  })
  satisfiedBps!: number | null;
  @ApiProperty({ nullable: true, type: Number }) asDescribedBps!: number | null;
  @ApiProperty({ nullable: true, type: Number }) arrivedOkBps!: number | null;
}

export class SubmitReviewRequest {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) rating!: number;
  @ApiProperty({ required: false, description: "At most the Market's title limit." })
  title?: string;
  @ApiProperty({ required: false, description: "At most the Market's body limit." })
  body?: string;
  @ApiProperty({ required: false, description: 'Show as "Verified buyer" with no name.' })
  anonymous?: boolean;
  @ApiProperty({
    required: false,
    description: "One of the Market's locales; default the Market's.",
  })
  locale?: string;
}

export class EditReviewRequest {
  @ApiProperty({ required: false, minimum: 1, maximum: 5 }) rating?: number;
  @ApiProperty({ required: false, nullable: true, type: String }) title?: string | null;
  @ApiProperty({ required: false, nullable: true, type: String }) body?: string | null;
  @ApiProperty({ required: false }) anonymous?: boolean;
}

export class DeletedReviewBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['deleted-by-author'] }) status!: string;
}

export class RateSellerOrderRequest {
  @ApiProperty({ minimum: 1, maximum: 5 }) satisfaction!: number;
  @ApiProperty() asDescribed!: boolean;
  @ApiProperty() arrivedOk!: boolean;
  @ApiProperty({
    required: false,
    enum: [...SELLER_RATING_REASONS],
    description: 'Only when arrivedOk is false.',
  })
  reasonCode?: string;
}

export class SettingsBody {
  @ApiProperty({ enum: [...REVIEWS_STATUSES] }) status!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) updatedAt!: string | null;
}

export class SetSettingsRequest {
  @ApiProperty({ enum: [...REVIEWS_STATUSES] }) status!: string;
}

const iso = (instant: { toString(): string }): string => instant.toString();
const isoOrNull = (instant: { toString(): string } | null): string | null =>
  instant === null ? null : instant.toString();

export const ownReviewBody = (view: OwnReviewView): OwnReviewBody => ({
  id: view.id,
  productId: view.productId,
  offerId: view.offerId,
  sellerId: view.sellerId,
  rating: view.rating,
  title: view.title,
  body: view.body,
  locale: view.locale,
  anonymous: view.anonymous,
  status: view.status,
  createdAt: iso(view.createdAt),
  editedAt: isoOrNull(view.editedAt),
  publishedAt: isoOrNull(view.publishedAt),
  lastPurchaseAt: iso(view.lastPurchaseAt),
  editableUntil: iso(view.editableUntil),
});

export const submittedReviewBody = (view: SubmittedReview): SubmittedReviewBody => ({
  outcome: view.outcome,
  review: ownReviewBody(view.review),
});

export const ownSellerRatingBody = (view: OwnSellerRatingView): OwnSellerRatingBody => ({
  id: view.id,
  sellerOrderId: view.sellerOrderId,
  sellerId: view.sellerId,
  satisfaction: view.satisfaction,
  asDescribed: view.asDescribed,
  arrivedOk: view.arrivedOk,
  reasonCode: view.reasonCode,
  status: view.status,
  createdAt: iso(view.createdAt),
});

export const toReviewBody = (view: ToReviewView): ToReviewBody => ({
  products: view.products.map((item) => ({
    productId: item.productId,
    offerId: item.offerId,
    sellerId: item.sellerId,
    sellerOrderId: item.sellerOrderId,
    deliveredAt: iso(item.deliveredAt),
    windowEndsAt: iso(item.windowEndsAt),
  })),
  sellerOrders: view.sellerOrders.map((item) => ({
    sellerOrderId: item.sellerOrderId,
    sellerId: item.sellerId,
    deliveredAt: iso(item.deliveredAt),
    windowEndsAt: iso(item.windowEndsAt),
  })),
});

export const myReviewsBody = (view: MyReviewsView): MyReviewsBody => ({
  reviews: view.reviews.map(ownReviewBody),
  sellerRatings: view.sellerRatings.map(ownSellerRatingBody),
});

export const publicReviewBody = (view: PublicReviewView): PublicReviewBody => ({
  id: view.id,
  rating: view.rating,
  title: view.title,
  body: view.body,
  locale: view.locale,
  author:
    view.author.kind === 'named'
      ? { kind: 'named', name: view.author.name }
      : { kind: view.author.kind },
  boughtFrom: { offerId: view.boughtFrom.offerId, sellerId: view.boughtFrom.sellerId },
  publishedOn: view.publishedOn,
  editedOn: view.editedOn,
});

export const productReviewsBody = (page: ProductReviewsPage): ProductReviewsBody => ({
  reviews: page.reviews.map(publicReviewBody),
  nextCursor: page.nextCursor,
});

export const productSummaryBody = (summary: ProductRatingSummary): ProductSummaryBody => ({
  productId: summary.productId,
  count: summary.count,
  averageTimes100: summary.averageTimes100,
  histogram: [...summary.histogram],
  shown: summary.shown,
});

export const sellerSummaryBody = (summary: SellerRatingSummary): SellerSummaryBody => ({
  ...summary,
  histogram: summary.histogram === null ? null : [...summary.histogram],
});

export const settingsBody = (view: SettingsView): SettingsBody => ({
  status: view.status,
  updatedAt: isoOrNull(view.updatedAt),
});

// ---- the moderator queue (package 2) ----------------------------------------------------------

export class ModerationReviewBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ minimum: 1, maximum: 5 }) rating!: number;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ nullable: true, type: String }) body!: string | null;
  @ApiProperty() locale!: string;
  @ApiProperty({ enum: [...REVIEW_STATUSES] }) status!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) editedAt!: string | null;
  @ApiProperty({ minimum: 0 }) openReports!: number;
  @ApiProperty({ type: [String], description: 'Automatic-check and abuse signal codes.' })
  signalCodes!: string[];
}

export class ModerationReportReasonBody {
  @ApiProperty() reasonCode!: string;
  @ApiProperty({ minimum: 1 }) count!: number;
}

export class ModerationHistoryBody {
  @ApiProperty() action!: string;
  @ApiProperty() reasonCode!: string;
  @ApiProperty({ enum: [...REVIEW_STATUSES], nullable: true, type: String })
  fromStatus!: string | null;
  @ApiProperty({ enum: [...REVIEW_STATUSES] }) toStatus!: string;
  @ApiProperty({ description: 'True for a moderator; the moderator is not named.' })
  byModerator!: boolean;
  @ApiProperty({ format: 'date-time' }) at!: string;
}

export class ModerationDetailBody extends ModerationReviewBody {
  @ApiProperty({ type: [ModerationReportReasonBody] }) reportReasons!: ModerationReportReasonBody[];
  @ApiProperty({ type: [ModerationHistoryBody] }) history!: ModerationHistoryBody[];
  @ApiProperty({ enum: [...MODERATOR_ACTIONS], isArray: true })
  allowedActions!: string[];
}

export class ModerationCountsBody {
  @ApiProperty() held!: number;
  @ApiProperty() reported!: number;
  @ApiProperty() actioned!: number;
}

export class ModerationQueueBody {
  @ApiProperty({ enum: [...QUEUE_TABS] }) tab!: string;
  @ApiProperty({ type: [ModerationReviewBody] }) items!: ModerationReviewBody[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty({ type: ModerationCountsBody }) counts!: ModerationCountsBody;
}

export class ModerateRequest {
  @ApiProperty({ description: 'A reason code of the action (a closed list; never free text).' })
  reasonCode!: string;
}

const moderationReviewBody = (view: ModerationReviewView): ModerationReviewBody => ({
  id: view.id,
  productId: view.productId,
  offerId: view.offerId,
  sellerId: view.sellerId,
  rating: view.rating,
  title: view.title,
  body: view.body,
  locale: view.locale,
  status: view.status,
  createdAt: iso(view.createdAt),
  editedAt: isoOrNull(view.editedAt),
  openReports: view.openReports,
  signalCodes: [...view.signalCodes],
});

export const moderationQueueBody = (page: ModerationQueuePage): ModerationQueueBody => ({
  tab: page.tab,
  items: page.items.map(moderationReviewBody),
  nextCursor: page.nextCursor,
  counts: { ...page.counts },
});

export const moderationDetailBody = (view: ModerationDetailView): ModerationDetailBody => ({
  ...moderationReviewBody(view),
  reportReasons: view.reportReasons.map((r) => ({ reasonCode: r.reasonCode, count: r.count })),
  history: view.history.map((h) => ({
    action: h.action,
    reasonCode: h.reasonCode,
    fromStatus: h.fromStatus,
    toStatus: h.toStatus,
    byModerator: h.byModerator,
    at: iso(h.at),
  })),
  allowedActions: [...view.allowedActions],
});
