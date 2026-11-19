import { ApiProperty } from '@nestjs/swagger';

// The answer of the "Custom variant labels" report (variants V2). Ids, codes and labels only.

export class LabelDifferenceDto {
  @ApiProperty({ description: 'The locale (BCP 47).' })
  locale!: string;

  @ApiProperty({ nullable: true, type: String, description: 'The label stored on the revision.' })
  stored!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The automatic label now; null when an option label is missing in the locale.',
  })
  built!: string | null;
}

export class CustomVariantLabelDto {
  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  productCode!: string;

  @ApiProperty({ format: 'uuid' })
  variantId!: string;

  @ApiProperty({ description: 'The number of the variant within its product.' })
  variantNo!: number;

  @ApiProperty({ description: '`{productCode}-{nn}`.' })
  variantCode!: string;

  @ApiProperty({ type: [LabelDifferenceDto] })
  differences!: LabelDifferenceDto[];
}

export class CustomVariantLabelsDto {
  @ApiProperty({ type: [CustomVariantLabelDto] })
  items!: CustomVariantLabelDto[];

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'Pass as afterId for the next page; null at the end.',
  })
  nextAfterId!: string | null;
}
