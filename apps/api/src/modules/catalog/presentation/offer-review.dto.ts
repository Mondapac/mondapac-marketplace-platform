import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { OFFER_CHANGE_REASONS } from '../domain/events';

// Bodies and answers of the admin Offer review routes (catalog design 4.4, 8.2, 9.2). Ids, codes
// and the seller's own Offer content only.

export class OfferApproveRequest {
  @ApiProperty({
    minimum: 1,
    description: 'The Offer version the reviewer saw (a row of the queue).',
  })
  version!: number;
}

export class OfferRequestChangesRequest {
  @ApiProperty({
    minimum: 1,
    description: 'The Offer version the reviewer saw (a row of the queue).',
  })
  version!: number;

  @ApiProperty({ enum: OFFER_CHANGE_REASONS, description: 'Why the seller must change the Offer.' })
  reasonCode!: string;
}

class ReviewQueueProduct {
  @ApiProperty({ nullable: true, type: String })
  productCode!: string | null;

  @ApiProperty({ nullable: true, type: String })
  typeCode!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'Published name, default locale.' })
  name!: string | null;
}

export class ReviewQueueRowDto {
  @ApiProperty({ enum: ['offer-first-publication'] })
  kind!: 'offer-first-publication';

  @ApiProperty({ format: 'uuid' })
  offerId!: string;

  @ApiProperty({ description: 'The version a decision must name.' })
  version!: number;

  @ApiProperty({ format: 'uuid' })
  sellerId!: string;

  @ApiProperty({ nullable: true, type: String, description: 'Public store name, if known.' })
  storeName!: string | null;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty({ type: ReviewQueueProduct })
  product!: ReviewQueueProduct;

  @ApiProperty()
  sellerSku!: string;

  @ApiProperty()
  conditionCode!: string;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  description!: Record<string, string>;

  @ApiProperty({ nullable: true, type: String })
  handling!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'ISO instant; oldest first.' })
  submittedAt!: string | null;
}

export class ProductRevisionRowDto {
  @ApiProperty({ enum: ['product-revision'] })
  kind!: 'product-revision';

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty({ format: 'uuid', description: 'The pending revision a decision must name.' })
  revisionId!: string;

  @ApiProperty()
  revisionNo!: number;

  @ApiProperty({ description: 'The product version a decision must name.' })
  version!: number;

  @ApiProperty({ format: 'uuid' })
  sellerId!: string;

  @ApiProperty({ nullable: true, type: String, description: 'Public store name, if known.' })
  storeName!: string | null;

  @ApiProperty({ type: ReviewQueueProduct })
  product!: ReviewQueueProduct;

  @ApiProperty({ description: 'True while the product has never been published.' })
  firstPublication!: boolean;

  @ApiProperty({ type: [String], description: 'What changed, as classification codes.' })
  reasons!: string[];

  @ApiProperty({
    type: [String],
    description: 'The named checks an approval must confirm in `checksConfirmed`.',
  })
  requiredChecks!: string[];

  @ApiProperty()
  hasImages!: boolean;

  @ApiProperty({ description: 'ISO instant; oldest first.' })
  submittedAt!: string;
}

@ApiExtraModels(ReviewQueueRowDto, ProductRevisionRowDto)
export class ReviewQueueList {
  @ApiProperty({
    type: 'array',
    items: {
      oneOf: [
        { $ref: getSchemaPath(ReviewQueueRowDto) },
        { $ref: getSchemaPath(ProductRevisionRowDto) },
      ],
    },
  })
  items!: (ReviewQueueRowDto | ProductRevisionRowDto)[];

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Opaque cursor; send as `afterId` for the next page.',
  })
  nextAfterId!: string | null;

  @ApiProperty({
    description: 'Every Offer and pending product revision in the queue, whatever the page.',
  })
  total!: number;
}

export class OfferDecided {}
