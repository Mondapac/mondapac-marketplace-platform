import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Bodies and answers of the admin topic routes (product tags package T1).

const NAMES_DESCRIPTION =
  'The name by locale, 2 to 40 characters each, no link. The Market default locale is required. ' +
  'A name that asserts a certification, or that another topic already uses, is refused.';
const SYNONYMS_DESCRIPTION =
  'Other words buyers use for the topic, by locale (a locale that has a name), at most 10 each, ' +
  '2 to 40 characters. Unique across the Market on the normalised form.';

export class TopicBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Lower case words joined by hyphens; fixed after creation.' })
  slug!: string;
  @ApiProperty({ enum: ['occasion', 'cuisine', 'use'] }) group!: string;
  @ApiProperty({ enum: ['active', 'archived'] }) status!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'The name by locale. The Market default locale is always present.',
  })
  names!: Record<string, string>;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
    description: 'The synonyms by locale, in order.',
  })
  synonyms!: Record<string, string[]>;
  @ApiProperty({ nullable: true, type: String, description: 'The intro of the topic page.' })
  intro!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ description: 'The version a change must name.' }) version!: number;
}

/** A topic as a product read names it (product tags T2). */
export class TopicRefBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ['active', 'archived'] }) status!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The name in the Market default locale, else any locale; null without one.',
  })
  name!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  names!: Record<string, string>;
}

/** An active topic in the seller's picker. */
export class OwnTopicItemBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ['occasion', 'cuisine', 'use'] }) group!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The name in the Market default locale, else any locale.',
  })
  name!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  names!: Record<string, string>;
}

export class OwnTopicListBody {
  @ApiProperty({ type: [OwnTopicItemBody] }) items!: OwnTopicItemBody[];
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) nextAfterId!: string | null;
  @ApiProperty({ description: 'The most topics a product may carry.' }) maxPerProduct!: number;
}

export class TopicWrapBody {
  @ApiProperty({ type: TopicBody }) topic!: TopicBody;
}

export class TopicLocalesBody {
  @ApiProperty({ description: 'The Market default locale; a name in it is required.' })
  default!: string;
  @ApiProperty({ type: [String], description: 'The locales a name may be given in.' })
  supported!: string[];
}

export class TopicListBody {
  @ApiProperty({ type: [TopicBody] }) items!: TopicBody[];
  @ApiProperty({ nullable: true, type: String, description: 'The `afterId` of the next page.' })
  nextAfterId!: string | null;
  @ApiProperty({ type: TopicLocalesBody }) locales!: TopicLocalesBody;
  @ApiProperty({ type: [String], description: 'The groups a topic may sit in.' })
  groups!: string[];
  @ApiProperty({ description: 'The most synonyms per locale.' }) maxSynonyms!: number;
}

export class TopicCreateRequest {
  @ApiProperty({ enum: ['occasion', 'cuisine', 'use'] }) group!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: NAMES_DESCRIPTION,
  })
  names!: Record<string, string>;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
    description: SYNONYMS_DESCRIPTION,
  })
  synonyms?: Record<string, string[]>;
  @ApiProperty({
    required: false,
    description: 'Optional fixed slug; derived from the default-locale name if absent.',
  })
  slug?: string;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    description: 'Up to 1000 characters, written by a person; no link.',
  })
  intro?: string | null;
}

export class TopicEditRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
  @ApiProperty({
    required: false,
    enum: ['active', 'archived'],
    description: 'Left out: unchanged.',
  })
  status?: string;
  @ApiProperty({ enum: ['occasion', 'cuisine', 'use'] }) group!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: NAMES_DESCRIPTION,
  })
  names!: Record<string, string>;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
    description: SYNONYMS_DESCRIPTION,
  })
  synonyms?: Record<string, string[]>;
  @ApiProperty({ required: false, nullable: true, type: String }) intro?: string | null;
}
