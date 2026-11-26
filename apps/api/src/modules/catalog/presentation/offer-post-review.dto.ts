import { ApiProperty } from '@nestjs/swagger';
import { OFFER_CHANGE_REASONS } from '../domain/events';
import { OFFER_STATUSES } from '../domain/offer';
import { OFFER_POST_REVIEW_REASONS, OFFER_POST_REVIEW_STATUSES } from '../domain/offer-post-review';
import { QueueSellerDto } from './offer-review.dto';
import {
  BulkDecideCountsBody,
  BulkDecideItemRequest,
  BulkDecideResultBody,
} from './queue-bulk.dto';

// Bodies and answers of the post-publication review list (risk-based Offer approval slice 6).
// Ids, codes and labels: never a price, a median or (outside the single read) the note.

class PostReviewDecisionDto {
  @ApiProperty({ enum: OFFER_CHANGE_REASONS, nullable: true, type: String })
  reasonCode!: string | null;
  @ApiProperty({
    nullable: true,
    type: Boolean,
    description: 'Take-down: the seller lost Trusted.',
  })
  misconduct!: boolean | null;
}

class PostReviewOfferDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: OFFER_STATUSES }) status!: string;
  @ApiProperty() listed!: boolean;
  @ApiProperty() sellerSku!: string;
}

class PostReviewProductDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The published name in the Market default locale.',
  })
  name!: string | null;
}

class PostReviewActionsDto {
  @ApiProperty({ description: 'Open and the caller holds catalog.product.approve.' })
  approve!: boolean;
  @ApiProperty({
    description:
      'Open, the Offer is published and the caller holds catalog.product.approve and ' +
      'catalog.product.delete.',
  })
  takeDown!: boolean;
}

export class OfferPostReviewRowDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'The row version; a decision names it.' }) version!: number;
  @ApiProperty({ enum: OFFER_POST_REVIEW_STATUSES }) status!: string;
  @ApiProperty({ enum: OFFER_POST_REVIEW_REASONS, isArray: true, description: 'Never empty.' })
  reasons!: string[];
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'With `sample`: the effective sampling percent (after doubling).',
  })
  samplePercent!: number | null;
  @ApiProperty({ description: 'The percent was doubled (Trusted for less than 30 days).' })
  sampleDoubled!: boolean;
  @ApiProperty() openedAt!: string;
  @ApiProperty({ nullable: true, type: String }) decidedAt!: string | null;
  @ApiProperty({ type: PostReviewDecisionDto, nullable: true })
  decision!: PostReviewDecisionDto | null;
  @ApiProperty({ type: PostReviewOfferDto, nullable: true }) offer!: PostReviewOfferDto | null;
  @ApiProperty({ type: PostReviewProductDto }) product!: PostReviewProductDto;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ nullable: true, type: String }) storeName!: string | null;
  @ApiProperty({ type: PostReviewActionsDto }) actions!: PostReviewActionsDto;
}

export class OfferPostReviewViewDto extends OfferPostReviewRowDto {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The decision note; null without catalog.product.approve.',
  })
  note!: string | null;
}

export class OfferPostReviewsListDto {
  @ApiProperty({ type: [OfferPostReviewRowDto] }) items!: OfferPostReviewRowDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ enum: ['pages', 'prev-next'] }) paging!: string;
  @ApiProperty() hasNext!: boolean;
  @ApiProperty({ nullable: true, type: Number, description: 'Pages mode only.' })
  total!: number | null;
  @ApiProperty({ description: 'Every open row of the Market (the tab count).' }) totalOpen!: number;
  @ApiProperty() searchCapped!: boolean;
  @ApiProperty({
    type: [QueueSellerDto],
    description: 'The stores with a row in the status view (at most 100).',
  })
  sellers!: QueueSellerDto[];
  @ApiProperty() sellersCapped!: boolean;
}

export class OfferPostReviewApproveRequest {
  @ApiProperty({ description: 'The row version the admin saw.' }) version!: number;
  @ApiProperty({ required: false, description: '1 to 2000 characters; never logged.' })
  note?: string;
}

export class OfferPostReviewTakeDownRequest {
  @ApiProperty({ description: 'The row version the admin saw.' }) version!: number;
  @ApiProperty({ enum: OFFER_CHANGE_REASONS }) reasonCode!: string;
  @ApiProperty({ description: 'True revokes the seller’s Trusted.' }) misconduct!: boolean;
  @ApiProperty({ description: '1 to 2000 characters; shown to nobody but admins; never logged.' })
  note!: string;
}

export class OfferPostReviewDecidedDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ enum: ['approved', 'taken-down'] }) status!: string;
  @ApiProperty() version!: number;
}

export class OfferPostReviewsBulkApproveRequest {
  @ApiProperty({ type: [BulkDecideItemRequest], description: '1 to 50 rows, no id twice.' })
  items!: BulkDecideItemRequest[];
}

export class OfferPostReviewsBulkApproveDto {
  @ApiProperty({ type: BulkDecideCountsBody, description: '`done` is the approved rows.' })
  counts!: BulkDecideCountsBody;
  @ApiProperty({
    type: [BulkDecideResultBody],
    description: 'Every row, in the order given; `name` is the product name.',
  })
  results!: BulkDecideResultBody[];
}
