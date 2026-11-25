import { ApiProperty } from '@nestjs/swagger';

// Answer of the seller typical-prices route. A range of minor-unit strings or nothing; never the
// median, a seller's price or a count of sellers.

export class TypicalRangeBody {
  @ApiProperty({ description: 'Lower edge, minor units as a string of digits.', example: '890' })
  lowMinor!: string;

  @ApiProperty({ description: 'Upper edge, minor units as a string of digits.', example: '2700' })
  highMinor!: string;
}

export class VariantTypicalPriceBody {
  @ApiProperty({ format: 'uuid' })
  variantId!: string;

  @ApiProperty({
    type: TypicalRangeBody,
    nullable: true,
    description:
      'Null when too few independent businesses sell this Variant, or the range cannot be read now.',
  })
  range!: TypicalRangeBody | null;
}

export class TypicalPricesBody {
  @ApiProperty({ format: 'uuid' })
  offerId!: string;

  @ApiProperty({ type: [VariantTypicalPriceBody] })
  variants!: VariantTypicalPriceBody[];
}
