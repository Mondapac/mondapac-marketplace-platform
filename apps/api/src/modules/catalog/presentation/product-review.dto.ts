import { ApiExtraModels, ApiProperty } from '@nestjs/swagger';
import { PRODUCT_CHANGE_REASONS } from '../domain/events';
import { REVIEW_CHECK_CODES } from '../domain/review-check-codes';
import { TopicRefBody } from './topic.dto';

// Bodies and answers of the admin product revision review routes (catalog design 4.2, 8.2, 8.3a).
// Ids and codes only.

export class ProductRevisionApproveRequest {
  @ApiProperty({
    minimum: 1,
    description: 'The product version the reviewer saw (a row of the review queue).',
  })
  version!: number;

  @ApiProperty({
    enum: REVIEW_CHECK_CODES,
    isArray: true,
    description:
      'The named checks the reviewer ticked. Every check the row lists in `requiredChecks` must be here.',
  })
  checksConfirmed!: string[];
}

export class ProductRevisionRequestChangesRequest {
  @ApiProperty({
    minimum: 1,
    description: 'The product version the reviewer saw (a row of the review queue).',
  })
  version!: number;

  @ApiProperty({
    enum: PRODUCT_CHANGE_REASONS,
    description: 'Why the seller must change the product.',
  })
  reasonCode!: string;
}

export class ProductRevisionDecided {}

class RevisionTextDto {
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) shortDescription!: string | null;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
}

class RevisionVariantDto {
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty() position!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Option code to value.',
  })
  optionValues!: Record<string, string>;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Locale to label.',
  })
  labels!: Record<string, string>;
  @ApiProperty({ nullable: true, type: String, description: '14 digits.' }) gtin!: string | null;
  @ApiProperty({ nullable: true, type: Number }) shippingWeightGrams!: number | null;
  @ApiProperty({ nullable: true, type: Number }) shippingLengthMm!: number | null;
  @ApiProperty({ nullable: true, type: Number }) shippingWidthMm!: number | null;
  @ApiProperty({ nullable: true, type: Number }) shippingHeightMm!: number | null;
  @ApiProperty({ type: [String], description: 'Photo ids; the first is the primary.' })
  imageIds!: string[];
}

export class AdminRevisionContentDto {
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ enum: ['submission', 'revert', 'tax-override', 'category-override'] })
  kind!: string;
  @ApiProperty({ enum: ['seller', 'admin'] }) authorKind!: string;
  @ApiProperty({ description: 'ISO instant.' }) submittedAt!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: '#/components/schemas/RevisionTextDto' },
    description: 'Locale to texts.',
  })
  texts!: Record<string, RevisionTextDto>;
  @ApiProperty({ type: [String], description: 'Platform category ids, in order.' })
  categoryIds!: string[];
  @ApiProperty({
    type: [String],
    description: 'Topic ids in the order entered (empty when none); named in `topicRefs`.',
  })
  topicIds!: string[];
  @ApiProperty() taxCategoryCode!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Attribute code to value, or to a locale map for a localizable attribute.',
  })
  attributeValues!: Record<string, unknown>;
  @ApiProperty({ type: [RevisionVariantDto] }) variants!: RevisionVariantDto[];
  @ApiProperty({
    type: [String],
    description: 'Photo ids in order; the photos come from .../revisions/:r/images.',
  })
  imageIds!: string[];
}

class RevisionDecisionDto {
  @ApiProperty({ enum: ['published', 'changes-requested', 'superseded'] }) outcome!: string;
  @ApiProperty({ nullable: true, type: String, description: 'reviewed | auto | admin-authored.' })
  publishKind!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'resubmitted | withdrawn | promoted | matched.',
  })
  supersededCause!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'The reason code of a send-back.' })
  reasonCode!: string | null;
  @ApiProperty({ enum: ['admin', 'seller', 'system'] }) decidedByKind!: string;
  @ApiProperty({ description: 'ISO instant.' }) decidedAt!: string;
}

class RevisionHistoryDto {
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ enum: ['submission', 'revert', 'tax-override', 'category-override'] })
  kind!: string;
  @ApiProperty({ enum: ['seller', 'admin'] }) authorKind!: string;
  @ApiProperty({ description: 'ISO instant.' }) submittedAt!: string;
  @ApiProperty({ type: RevisionDecisionDto, nullable: true })
  decision!: RevisionDecisionDto | null;
}

@ApiExtraModels(RevisionTextDto)
export class ProductRevisionAdminReadDto {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty() productCode!: string;
  @ApiProperty() typeCode!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ description: 'The product version a decision must name.' }) version!: number;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ nullable: true, type: String }) storeName!: string | null;
  @ApiProperty({
    enum: ['pending', 'published', 'closed'],
    description: 'pending waits for a decision; published is live; closed was decided or replaced.',
  })
  state!: string;
  @ApiProperty() firstPublication!: boolean;
  @ApiProperty({ type: [String], description: 'Classification codes (what changed).' })
  reasons!: string[];
  @ApiProperty({
    enum: REVIEW_CHECK_CODES,
    isArray: true,
    description: 'The checks an approval must confirm; empty unless pending.',
  })
  requiredChecks!: string[];
  @ApiProperty({
    type: [String],
    description: 'gtin.duplicate-platform or gtin.duplicate (advice only); empty unless pending.',
  })
  warnings!: string[];
  @ApiProperty({ type: AdminRevisionContentDto }) revision!: AdminRevisionContentDto;
  @ApiProperty({
    type: [TopicRefBody],
    description: 'The topics of the revision and of the published one, each once.',
  })
  topicRefs!: TopicRefBody[];
  @ApiProperty({
    type: 'object',
    properties: {
      added: { type: 'array', items: { type: 'string', format: 'uuid' } },
      removed: { type: 'array', items: { type: 'string', format: 'uuid' } },
    },
    description:
      'Topic ids the revision adds to and removes from the published set (all added before the ' +
      'first publication). A reorder is neither.',
  })
  topicDiff!: { added: string[]; removed: string[] };
  @ApiProperty({
    type: AdminRevisionContentDto,
    nullable: true,
    description: 'The published revision; null before the first publication.',
  })
  published!: AdminRevisionContentDto | null;
  @ApiProperty({ type: [RevisionHistoryDto], description: 'Newest first, at most 50.' })
  history!: RevisionHistoryDto[];
}
