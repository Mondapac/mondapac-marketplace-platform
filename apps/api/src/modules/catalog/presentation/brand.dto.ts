import { ApiProperty } from '@nestjs/swagger';

// Bodies and answers of the brand routes (catalog brand package). Ids, slugs and the text an
// admin or a seller typed; never an account id of a seller or a permission.

export class BrandBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Lower case words joined by hyphens: the URL of the public page.' })
  slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) summary!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'ISO 3166-1 alpha-2, upper case.' })
  originCountry!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) logoImageId!: string | null;
  @ApiProperty({ nullable: true, type: String }) logoAlt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) headerImageId!: string | null;
  @ApiProperty({ enum: ['draft', 'active', 'archived'] }) status!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) proposedBySellerId!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) approvedBy!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'Set when a merge archived this brand: the brand that took its products.',
  })
  mergedIntoId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ description: 'The version a change must name.' }) version!: number;
}

export class BrandDetailBody extends BrandBody {
  @ApiProperty({ type: [String], description: 'Other spellings that resolve to this brand.' })
  aliases!: string[];
  @ApiProperty({ description: "Products of the request's Market that point at this brand." })
  productCount!: number;
}

export class BrandWrapBody {
  @ApiProperty({ type: BrandBody }) brand!: BrandBody;
}

export class BrandListBody {
  @ApiProperty({ type: [BrandBody] }) items!: BrandBody[];
  @ApiProperty({ nullable: true, type: String, description: 'The `afterId` of the next page.' })
  nextAfterId!: string | null;
}

export class BrandCreateRequest {
  @ApiProperty({ description: 'The brand name, 1 to 120 characters.' }) name!: string;
  @ApiProperty({
    required: false,
    description: 'Optional URL slug; derived from the name if absent.',
  })
  slug?: string;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    description: 'Up to 1000 characters.',
  })
  summary?: string | null;
  @ApiProperty({ required: false, nullable: true, type: String, example: 'JP' })
  originCountry?: string | null;
  @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid' })
  logoImageId?: string | null;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    description: 'Required with a logo.',
  })
  logoAlt?: string | null;
  @ApiProperty({ required: false, nullable: true, type: String, format: 'uuid' })
  headerImageId?: string | null;
}

export class BrandEditRequest extends BrandCreateRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
}

export class BrandVersionRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
}

export class BrandMergeRequest {
  @ApiProperty({
    required: false,
    type: [String],
    description:
      'Brands that are merged into the brand of the path, at most 10. Each is archived; its name ' +
      'and aliases become aliases of the target.',
  })
  sourceBrandIds?: string[];
  @ApiProperty({
    required: false,
    type: [String],
    description: 'Extra spellings that should resolve to the target, at most 20.',
  })
  aliases?: string[];
}

export class BrandMergedSource {
  @ApiProperty({ format: 'uuid' }) brandId!: string;
  @ApiProperty({ description: "Products of the request's Market that now point at the target." })
  productsMoved!: number;
}

export class BrandMergeBody {
  @ApiProperty({ type: BrandBody }) brand!: BrandBody;
  @ApiProperty({ type: [BrandMergedSource] }) merged!: BrandMergedSource[];
  @ApiProperty({ type: [String], description: 'The aliases that were new.' })
  aliasesAdded!: string[];
}

export class MergeQueueBrandBody extends BrandBody {
  @ApiProperty({ description: "Products of the request's Market that use this brand." })
  productCount!: number;
}

export class MergeQueueGroupBody {
  @ApiProperty({ description: 'The shared name key; what a dismissal names.' }) groupKey!: string;
  @ApiProperty({ type: [MergeQueueBrandBody] }) brands!: MergeQueueBrandBody[];
}

export class MergeQueueBody {
  @ApiProperty({ type: [MergeQueueGroupBody] }) groups!: MergeQueueGroupBody[];
}

export class MergeQueueDismissRequest {
  @ApiProperty({ description: 'The `groupKey` of the group whose brands stay apart.' })
  groupKey!: string;
}

export class MergeQueueDismissedBody {
  @ApiProperty({ description: 'The brands of the group that stay apart.' }) resolved!: number;
}

export class BrandProposeRequest {
  @ApiProperty({ description: 'The brand name, 1 to 120 characters.' }) name!: string;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    description: 'Up to 1000 characters.',
  })
  summary?: string | null;
  @ApiProperty({ required: false, nullable: true, type: String, example: 'JP' })
  originCountry?: string | null;
}

export class BrandProposedBody {
  @ApiProperty({ format: 'uuid' }) brandId!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ['draft'], description: 'Inactive until an admin approves it.' })
  status!: string;
}

export class PublicBrandBody {
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) summary!: string | null;
  @ApiProperty({ nullable: true, type: String }) originCountry!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) logoImageId!: string | null;
  @ApiProperty({ nullable: true, type: String }) logoAlt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) headerImageId!: string | null;
  @ApiProperty({
    description:
      "Live products of the brand in the request's Market: published, with an Offer on sale.",
  })
  productCount!: number;
}

export class PublicBrandAzEntryBody {
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) logoImageId!: string | null;
  @ApiProperty({ nullable: true, type: String }) logoAlt!: string | null;
}

export class PublicBrandAzSectionBody {
  @ApiProperty({ description: '`A` to `Z`, or `#` for any other first character.' })
  letter!: string;
  @ApiProperty({ type: [PublicBrandAzEntryBody] }) brands!: PublicBrandAzEntryBody[];
}

export class PublicBrandAzBody {
  @ApiProperty({ type: [PublicBrandAzSectionBody] }) sections!: PublicBrandAzSectionBody[];
  @ApiProperty({ description: 'True when there are more brands than one answer lists.' })
  truncated!: boolean;
}
