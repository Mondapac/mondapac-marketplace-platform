import { ApiProperty } from '@nestjs/swagger';
import { SELLER_REPORT_REASONS } from '../domain/seller-reply';
import type {
  SellerReplyView,
  SellerReviewsPage,
  SellerReviewView,
} from '../application/use-cases/list-seller-reviews.use-case';

export class SellerReplyBody {
  @ApiProperty() body!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) editedAt!: string | null;
  @ApiProperty({ format: 'date-time', description: 'After this instant the reply cannot change.' })
  editableUntil!: string;
}

export class SellerReviewBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'The seller order of the purchase: the only thing that names the buyer.',
  })
  orderRef!: string | null;
  @ApiProperty({ minimum: 1, maximum: 5 }) rating!: number;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ nullable: true, type: String }) body!: string | null;
  @ApiProperty() locale!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) publishedAt!: string | null;
  @ApiProperty({ type: SellerReplyBody, nullable: true }) reply!: SellerReplyBody | null;
}

export class SellerReviewsBody {
  @ApiProperty({ type: [SellerReviewBody] }) items!: SellerReviewBody[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class ReplyRequest {
  @ApiProperty({ description: 'Plain text, at most the Market reply length.' }) body!: string;
}

export class ReportRequest {
  @ApiProperty({ enum: [...SELLER_REPORT_REASONS] }) reasonCode!: string;
}

export class ReportedBody {
  @ApiProperty({ enum: [true] }) reported!: true;
}

const replyBody = (reply: SellerReplyView): SellerReplyBody => ({
  body: reply.body,
  createdAt: reply.createdAt.toString(),
  editedAt: reply.editedAt?.toString() ?? null,
  editableUntil: reply.editableUntil.toString(),
});

export const sellerReviewBody = (view: SellerReviewView): SellerReviewBody => ({
  id: view.id,
  productId: view.productId,
  offerId: view.offerId,
  orderRef: view.orderRef,
  rating: view.rating,
  title: view.title,
  body: view.body,
  locale: view.locale,
  publishedAt: view.publishedAt?.toString() ?? null,
  reply: view.reply === null ? null : replyBody(view.reply),
});

export const sellerReviewsBody = (page: SellerReviewsPage): SellerReviewsBody => ({
  items: page.items.map(sellerReviewBody),
  nextCursor: page.nextCursor,
});
