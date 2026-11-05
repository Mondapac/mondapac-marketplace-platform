import { ApiProperty } from '@nestjs/swagger';

// Bodies and answers of the value-suggestion routes (attributes plan, package A5). The seller's
// text is shown to the admin who decides it and to nobody else; the reason is the reviewer's.

const LOCALIZED = {
  type: 'object',
  additionalProperties: { type: 'string' },
  description: 'Locale (BCP 47) to text.',
} as const;

export class SuggestValueRequest {
  @ApiProperty({ description: 'The code of the field, as the product form names it.' })
  attributeCode!: string;
  @ApiProperty({ description: 'The value the seller wants, 1 to 120 characters of plain text.' })
  label!: string;
}

export class SuggestionOpenedBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() attributeCode!: string;
  @ApiProperty({ enum: ['open'] }) status!: string;
  @ApiProperty() version!: number;
}

export class SuggestionOptionBody {
  @ApiProperty() code!: string;
  @ApiProperty(LOCALIZED) labels!: Record<string, string>;
}

export class SuggestionAttributeBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty(LOCALIZED) names!: Record<string, string>;
  @ApiProperty() multi!: boolean;
  @ApiProperty({ type: [SuggestionOptionBody], description: 'The active values, to map to.' })
  options!: SuggestionOptionBody[];
}

export class SuggestionItemBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'The version a decision must name.' }) version!: number;
  @ApiProperty({ description: "The seller's own words. Plain text; never render as markup." })
  label!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ nullable: true, type: String }) productCode!: string | null;
  @ApiProperty({ type: SuggestionAttributeBody }) attribute!: SuggestionAttributeBody;
}

export class SuggestionLocalesBody {
  @ApiProperty() default!: string;
  @ApiProperty({ type: [String] }) supported!: string[];
}

export class SuggestionListBody {
  @ApiProperty({ type: [SuggestionItemBody] }) items!: SuggestionItemBody[];
  @ApiProperty({
    type: [String],
    description: 'The locales an approval must name the value in.',
  })
  requiredLocales!: string[];
  @ApiProperty({ type: SuggestionLocalesBody }) locales!: SuggestionLocalesBody;
}

export class SuggestionApproveRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
  @ApiProperty(LOCALIZED) labels!: Record<string, string>;
  @ApiProperty({
    required: false,
    description: 'The code of the new value; derived from the default-locale label if absent.',
  })
  optionCode?: string;
}

export class SuggestionMapRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
  @ApiProperty({ description: 'The code of an active value the attribute already has.' })
  optionCode!: string;
}

export class SuggestionRejectRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
  @ApiProperty({ description: 'The words the seller will read, 1 to 300 characters.' })
  reason!: string;
}

export class SuggestionDecidedBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['approved', 'mapped', 'rejected'] }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ nullable: true, type: String }) optionCode!: string | null;
}

export class SuggestionDecisionWrapBody {
  @ApiProperty({ type: SuggestionDecidedBody }) suggestion!: SuggestionDecidedBody;
}

export class OwnSuggestionAttributeBody {
  @ApiProperty() code!: string;
  @ApiProperty(LOCALIZED) names!: Record<string, string>;
}

export class OwnSuggestionProductBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Null when the product can no longer be read.',
  })
  productCode!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "The draft name in the Market's default locale.",
  })
  name!: string | null;
}

export class OwnSuggestionItemBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['open', 'approved', 'mapped', 'rejected'] }) status!: string;
  @ApiProperty({ description: "The seller's own words. Plain text; never render as markup." })
  label!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) decidedAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "The reviewer's words, for a rejected suggestion. Plain text.",
  })
  rejectReason!: string | null;
  @ApiProperty({
    type: OwnSuggestionAttributeBody,
    nullable: true,
    description: 'Null when the attribute can no longer be read.',
  })
  attribute!: OwnSuggestionAttributeBody | null;
  @ApiProperty({
    type: SuggestionOptionBody,
    nullable: true,
    description: 'The value added (approved) or matched (mapped).',
  })
  value!: SuggestionOptionBody | null;
  @ApiProperty({ type: OwnSuggestionProductBody }) product!: OwnSuggestionProductBody;
}

export class OwnSuggestionListBody {
  @ApiProperty({ type: [OwnSuggestionItemBody] }) items!: OwnSuggestionItemBody[];
  @ApiProperty({ nullable: true, type: String, description: 'The afterId of the next page.' })
  nextAfterId!: string | null;
  @ApiProperty({ description: "How many of the seller's suggestions wait for a decision." })
  openCount!: number;
  @ApiProperty({ description: 'How many may wait at once.' }) maxOpen!: number;
  @ApiProperty({ type: SuggestionLocalesBody }) locales!: SuggestionLocalesBody;
}
