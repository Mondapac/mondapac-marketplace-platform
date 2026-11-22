import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// The request and answer of `claim-terms.impact-count` (catalog design 6.5, request C-7).

export class ClaimTermsImpactCountRequest {
  @ApiPropertyOptional({
    description:
      'The code of the type being edited; absent for a type not yet created. Only labels the match.',
    example: 'zorbex',
  })
  typeCode?: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
    description:
      'The terms the revision would publish, per locale of the Market (at most 200 per locale, ' +
      '100 characters each). Checked as a type revision checks them: a term the matcher cannot ' +
      'use is refused (validation.failed), never dropped. At least one term overall.',
    example: { en: ['zorbex pure'] },
  })
  termsByLocale!: Record<string, string[]>;
}

export class ClaimTermsImpactCountBody {
  @ApiProperty({ description: 'Published products with a text the terms would match.' })
  products!: number;

  @ApiProperty({ description: 'Published Offers whose description the terms would match.' })
  offers!: number;

  @ApiProperty({ description: 'products + offers.' })
  total!: number;

  @ApiProperty({
    description:
      'False when the scan stopped at 20,000 texts or 10 seconds: the numbers are "at least".',
  })
  complete!: boolean;
}
