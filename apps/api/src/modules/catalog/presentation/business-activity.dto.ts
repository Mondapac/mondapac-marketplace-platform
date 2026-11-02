import { ApiProperty } from '@nestjs/swagger';

// Bodies and answers of the business-activity routes (catalog business-activity package).

export class BusinessActivityBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Lower case words joined by hyphens; fixed after creation.' })
  code!: string;
  @ApiProperty({ enum: ['active', 'inactive'] }) status!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'The name by locale. The Market default locale is always present.',
  })
  names!: Record<string, string>;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({
    type: [String],
    description: 'The category branches (level 1 or 2) the activity reaches; children inherit.',
  })
  categoryIds!: string[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ description: 'The version a change must name.' }) version!: number;
}

export class BusinessActivityWrapBody {
  @ApiProperty({ type: BusinessActivityBody }) activity!: BusinessActivityBody;
}

export class BusinessActivityLocalesBody {
  @ApiProperty({ description: 'The Market default locale; a name in it is required.' })
  default!: string;
  @ApiProperty({ type: [String], description: 'The locales a name may be given in.' })
  supported!: string[];
}

export class BusinessActivityListBody {
  @ApiProperty({ type: [BusinessActivityBody] }) items!: BusinessActivityBody[];
  @ApiProperty({ nullable: true, type: String, description: 'The `afterId` of the next page.' })
  nextAfterId!: string | null;
  @ApiProperty({ type: BusinessActivityLocalesBody })
  locales!: BusinessActivityLocalesBody;
}

export class BusinessActivityCreateRequest {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'The name by locale, 1 to 80 characters each. The Market default locale is required. A name ' +
      'that asserts a certification is refused.',
  })
  names!: Record<string, string>;
  @ApiProperty({
    required: false,
    description: 'Optional fixed code; derived from the default-locale name if absent.',
  })
  code?: string;
  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    description: 'Up to 300 characters.',
  })
  description?: string | null;
  @ApiProperty({
    required: false,
    type: [String],
    description: 'Live category ids on level 1 or 2 of the tree, at most 100.',
  })
  categoryIds?: string[];
}

export class BusinessActivityEditRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
  @ApiProperty({
    required: false,
    enum: ['active', 'inactive'],
    description: 'Left out: unchanged.',
  })
  status?: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  names!: Record<string, string>;
  @ApiProperty({ required: false, nullable: true, type: String }) description?: string | null;
  @ApiProperty({ required: false, type: [String] }) categoryIds?: string[];
}
