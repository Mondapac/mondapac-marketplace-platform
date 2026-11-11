import { ApiProperty } from '@nestjs/swagger';

// Bodies and answers of the culture routes (multi-culture package 1; ADR-0047).

export class CultureNameBody {
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
}

export class CultureBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Lower case words joined by hyphens; fixed after creation.' })
  code!: string;
  @ApiProperty({ enum: ['draft', 'active', 'inactive'] }) status!: string;
  @ApiProperty() displayOrder!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'A certification type code of the Market, or null.',
  })
  requiredCertificationType!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'A design-token name.' })
  badgeColour!: string | null;
  @ApiProperty({ description: 'At most one culture of a Market is the default; it is active.' })
  isDefault!: boolean;
  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: '#/components/schemas/CultureNameBody' },
    description: 'Name and description by locale. The Market default locale is always present.',
  })
  names!: Record<string, CultureNameBody>;
  @ApiProperty({
    type: [String],
    description: 'Locales whose name and description both exist; only these are ever shown.',
  })
  publishedLocales!: string[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ description: 'The version a change must name.' }) version!: number;
}

export class CultureWrapBody {
  @ApiProperty({ type: CultureBody }) culture!: CultureBody;
}

export class CultureListBody {
  @ApiProperty({ type: [CultureBody] }) items!: CultureBody[];
}

export class CultureCreateRequest {
  @ApiProperty({
    description: 'Fixed after creation: lower case words joined by hyphens, up to 40.',
  })
  code!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: '#/components/schemas/CultureNameBody' },
    description:
      'Name (1 to 80) and description (1 to 300) by locale. The Market default locale needs both. ' +
      'Text that asserts a certification is refused.',
  })
  names!: Record<string, CultureNameBody>;
  @ApiProperty({ required: false, description: '0 to 9999; default 0.' }) displayOrder?: number;
  @ApiProperty({ required: false, nullable: true, type: String }) badgeColour?: string | null;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    description: 'An active certification type code of the Market.',
  })
  requiredCertificationType?: string | null;
}

export class CultureEditRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
  @ApiProperty({
    required: false,
    type: Object,
    additionalProperties: { $ref: '#/components/schemas/CultureNameBody' },
    description: 'The whole set of names when given; left out: unchanged.',
  })
  names?: Record<string, CultureNameBody>;
  @ApiProperty({ required: false }) displayOrder?: number;
  @ApiProperty({
    required: false,
    enum: ['draft', 'active', 'inactive'],
    description: 'draft to active, active to inactive and back; never back to draft.',
  })
  status?: string;
  @ApiProperty({ required: false, nullable: true, type: String, description: 'null clears.' })
  badgeColour?: string | null;
  @ApiProperty({ required: false, nullable: true, type: String, description: 'null clears.' })
  requiredCertificationType?: string | null;
  @ApiProperty({
    required: false,
    description: 'true makes this the Market default (it must be active); false is refused.',
  })
  isDefault?: boolean;
}

export class MarkSourceBody {
  @ApiProperty({ enum: ['default', 'own', 'inherited'] }) kind!: string;
  @ApiProperty({ required: false, format: 'uuid' }) fromCategoryId?: string;
}

export class CultureCategoryOwnBody {
  @ApiProperty() visible!: boolean;
  @ApiProperty({ nullable: true, enum: ['required', 'neutral'], type: String })
  certificationMark!: string | null;
}

export class CultureCategoryEffectiveBody {
  @ApiProperty() visible!: boolean;
  @ApiProperty({ enum: ['required', 'neutral'] }) certificationMark!: string;
  @ApiProperty({ type: MarkSourceBody }) visibleSource!: MarkSourceBody;
  @ApiProperty({ type: MarkSourceBody }) markSource!: MarkSourceBody;
}

export class CultureCategoryMarkBody {
  @ApiProperty({ format: 'uuid' }) categoryId!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) parentId!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty({ description: '0 for a top-level category.' }) depth!: number;
  @ApiProperty({ nullable: true, type: CultureCategoryOwnBody })
  own!: CultureCategoryOwnBody | null;
  @ApiProperty({ type: CultureCategoryEffectiveBody }) effective!: CultureCategoryEffectiveBody;
}

export class CultureCategoryMarksBody {
  @ApiProperty({ format: 'uuid' }) cultureId!: string;
  @ApiProperty({ nullable: true, type: String }) requiredCertificationType!: string | null;
  @ApiProperty({ type: [CultureCategoryMarkBody] }) items!: CultureCategoryMarkBody[];
}

export class CultureCategoryMarkWrapBody {
  @ApiProperty({ type: CultureCategoryMarkBody }) mark!: CultureCategoryMarkBody;
}

export class CultureCategoryMarkSetRequest {
  @ApiProperty({
    required: false,
    description: 'Default true. false hides the branch for the culture.',
  })
  visible?: boolean;
  @ApiProperty({
    required: false,
    nullable: true,
    enum: ['required', 'neutral'],
    type: String,
    description: 'null or left out: inherit from the nearest ancestor (default required).',
  })
  certificationMark?: string | null;
}

export class CultureCategoryMarkClearBody {
  @ApiProperty() cleared!: boolean;
}
