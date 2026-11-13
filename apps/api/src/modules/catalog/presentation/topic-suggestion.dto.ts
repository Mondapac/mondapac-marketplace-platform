import { ApiProperty } from '@nestjs/swagger';

// Bodies and answers of the tag-suggestion routes (product tags package T5). The seller's
// text is shown to the admin who decides it and to nobody else; the reason is the reviewer's.

const LOCALIZED = {
  type: 'object',
  additionalProperties: { type: 'string' },
  description: 'Locale (BCP 47) to text.',
} as const;

export class SuggestTopicRequest {
  @ApiProperty({ description: 'The tag the seller wants, 2 to 40 characters of plain text.' })
  label!: string;
}

export class SuggestionOpenedBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['open'] }) status!: string;
  @ApiProperty() version!: number;
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
  @ApiProperty({ description: 'The slug the label suggests, for the approve form.' })
  suggestedSlug!: string;
}

export class SuggestionLocalesBody {
  @ApiProperty() default!: string;
  @ApiProperty({ type: [String] }) supported!: string[];
}

export class SuggestionListBody {
  @ApiProperty({ type: [SuggestionItemBody] }) items!: SuggestionItemBody[];
  @ApiProperty({
    type: [String],
    description: 'The locales an approval must name the tag in.',
  })
  requiredLocales!: string[];
  @ApiProperty({ type: SuggestionLocalesBody }) locales!: SuggestionLocalesBody;
}

export class SuggestionApproveRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
  @ApiProperty({ enum: ['occasion', 'cuisine', 'use'] }) group!: string;
  @ApiProperty({
    required: false,
    description: "The tag's name in the default locale; the seller's text if absent.",
  })
  name?: string;
  @ApiProperty({
    required: false,
    description: 'The slug of the new tag; derived from the name if absent.',
  })
  slug?: string;
}

export class SuggestionMapRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
  @ApiProperty({ format: 'uuid', description: 'An active tag the list already has.' })
  topicId!: string;
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
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) topicId!: string | null;
}

export class SuggestionDecisionWrapBody {
  @ApiProperty({ type: SuggestionDecidedBody }) suggestion!: SuggestionDecidedBody;
}

export class OwnSuggestionTopicBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ['active', 'archived'] }) status!: string;
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
    type: OwnSuggestionTopicBody,
    nullable: true,
    description: 'The tag created (approved) or matched (mapped).',
  })
  topic!: OwnSuggestionTopicBody | null;
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
