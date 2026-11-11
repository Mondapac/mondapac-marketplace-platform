import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VARIANT_ISSUES } from '../application/use-cases/admin-variants-list.use-case';
import { VARIANT_DISPLAY_STYLES, VARIANT_OPTION_ORDERS } from '../domain/variant-type-settings';

// The answers of the admin Catalogue > Variants page (variants V6). Ids, codes, counts and the
// texts admins already see in Attributes and Products.

const LOCALIZED = {
  type: 'object',
  additionalProperties: { type: 'string' },
  description: 'Locale (BCP 47) to text.',
} as const;

export class VariantTypeLanguageDto {
  @ApiProperty()
  locale!: string;

  @ApiProperty({ description: 'The variant type has no name in this locale.' })
  nameMissing!: boolean;

  @ApiProperty({ description: 'Active options without a label in this locale.' })
  optionsMissing!: number;
}

export class VariantTypeFeatureSetDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty(LOCALIZED)
  names!: Record<string, string>;
}

export class VariantTypeSummaryDto {
  @ApiProperty({ format: 'uuid', description: 'The attribute definition.' })
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty({ enum: ['draft', 'active'] })
  status!: 'draft' | 'active';

  @ApiProperty(LOCALIZED)
  names!: Record<string, string>;

  @ApiProperty({ enum: VARIANT_DISPLAY_STYLES })
  displayStyle!: string;

  @ApiProperty({ enum: VARIANT_OPTION_ORDERS })
  optionOrder!: string;

  @ApiProperty({ description: 'Active options.' })
  options!: number;

  @ApiProperty({ description: 'Live products with a variant of this type.' })
  products!: number;

  @ApiProperty({ description: 'Live variants with a value of this type.' })
  liveVariants!: number;

  @ApiProperty({ type: [VariantTypeFeatureSetDto] })
  featureSets!: VariantTypeFeatureSetDto[];

  @ApiProperty({ type: [VariantTypeLanguageDto] })
  languages!: VariantTypeLanguageDto[];
}

export class VariantTypeListDto {
  @ApiProperty({ type: [VariantTypeSummaryDto] })
  items!: VariantTypeSummaryDto[];
}

export class VariantTypeOptionDto {
  @ApiProperty()
  code!: string;

  @ApiProperty(LOCALIZED)
  labels!: Record<string, string>;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({ description: 'The manual position set in Attributes.' })
  position!: number;

  @ApiProperty({ nullable: true, type: String, description: '`#RRGGBB`, or null.' })
  swatch!: string | null;

  @ApiProperty({ description: 'Live products with a variant of this option.' })
  products!: number;
}

export class VariantTypeDetailDto extends VariantTypeSummaryDto {
  @ApiProperty({
    type: [VariantTypeOptionDto],
    description: 'In the order buyers see them in the default locale.',
  })
  optionList!: VariantTypeOptionDto[];

  @ApiProperty(LOCALIZED)
  sellerHelp!: Record<string, string>;

  @ApiProperty({ description: 'Name it in a settings write; 0 while the defaults apply.' })
  settingsVersion!: number;
}

export class VariantTypeDetailBody {
  @ApiProperty({ type: VariantTypeDetailDto })
  variantType!: VariantTypeDetailDto;
}

export class VariantTypeSettingsRequest {
  @ApiProperty({ description: 'The settings version read; 0 while the defaults apply.' })
  version!: number;

  @ApiProperty({ enum: VARIANT_DISPLAY_STYLES })
  displayStyle!: string;

  @ApiProperty({ enum: VARIANT_OPTION_ORDERS })
  optionOrder!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Option code to colour `#RRGGBB`. Omitted options show their label.',
  })
  swatches?: Record<string, string>;

  @ApiPropertyOptional({
    ...LOCALIZED,
    description: 'Locale to one sentence (at most 200 characters) above the variant grid.',
  })
  sellerHelp?: Record<string, string>;
}

export class VariantTypeSettingsViewDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  settingsVersion!: number;

  @ApiProperty({ enum: VARIANT_DISPLAY_STYLES })
  displayStyle!: string;

  @ApiProperty({ enum: VARIANT_OPTION_ORDERS })
  optionOrder!: string;
}

export class VariantTypeSettingsBody {
  @ApiProperty({ type: VariantTypeSettingsViewDto })
  variantType!: VariantTypeSettingsViewDto;
}

export class AdminVariantDto {
  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  productCode!: string;

  @ApiProperty({ nullable: true, type: String, description: 'In the default locale.' })
  productName!: string | null;

  @ApiProperty({ enum: ['PLATFORM', 'SELLER'] })
  productScope!: string;

  @ApiProperty({ enum: ['live', 'paused'] })
  status!: string;

  @ApiProperty({ format: 'uuid' })
  variantId!: string;

  @ApiProperty()
  variantNo!: number;

  @ApiProperty({ description: '`{productCode}-{nn}`.' })
  variantCode!: string;

  @ApiProperty({ nullable: true, type: String, description: 'In the default locale.' })
  label!: string | null;

  @ApiProperty(LOCALIZED)
  labels!: Record<string, string>;

  @ApiProperty({ nullable: true, type: String, description: '14 digits.' })
  gtin!: string | null;

  @ApiProperty({ description: 'Listed Offers of the product.' })
  sellers!: number;

  @ApiProperty({ enum: VARIANT_ISSUES, isArray: true })
  issues!: string[];

  @ApiProperty({ type: [String], description: 'Supported locales the label lacks.' })
  missingLocales!: string[];
}

export class AdminVariantListDto {
  @ApiProperty({ type: [AdminVariantDto] })
  items!: AdminVariantDto[];

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'Pass as after for the next page; null at the end.',
  })
  nextAfter!: string | null;
}

export class AdminVariantIssueCountsDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    description: `Each of ${VARIANT_ISSUES.join(', ')} to its count.`,
  })
  counts!: Record<string, number>;
}
