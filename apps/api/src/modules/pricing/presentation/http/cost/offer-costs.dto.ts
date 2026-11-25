import { ApiProperty } from '@nestjs/swagger';

// Bodies of the seller Cost routes (pricing design 6.5; ux F41, C5). Ids, codes and minor-unit
// strings only. Cost appears only in these bodies; every answer is `Cache-Control: no-store`.

export class CostMoney {
  @ApiProperty({ description: 'Minor units as a string of digits.', example: '1250' })
  amount!: string;

  @ApiProperty({ description: "The Market's currency (ISO 4217)." })
  currency!: string;
}

export class VariantCostBody {
  @ApiProperty({ format: 'uuid' })
  variantId!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Send as expectedVersion with the next Cost write; null when no Cost series exists.',
  })
  seriesVersion!: number | null;

  @ApiProperty({ type: CostMoney, nullable: true, description: 'Null: no cost recorded.' })
  cost!: CostMoney | null;
}

export class OfferCostsBody {
  @ApiProperty({ format: 'uuid' })
  offerId!: string;

  @ApiProperty({ description: 'The Market currency every Cost is written in.' })
  currency!: string;

  @ApiProperty({ type: [VariantCostBody] })
  variants!: VariantCostBody[];
}

export class CostRequest {
  @ApiProperty({
    type: CostMoney,
    nullable: true,
    description: 'The Cost of one unit, GST included; null clears it.',
  })
  cost!: CostMoney | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'The Cost series version the screen showed, or null. A mismatch is conflict.stale.',
  })
  expectedVersion!: number | null;
}

export class CostWritten {
  @ApiProperty({ enum: ['recorded', 'cleared', 'unchanged'] })
  status!: 'recorded' | 'cleared' | 'unchanged';

  @ApiProperty({ type: Number, nullable: true })
  seriesVersion!: number | null;
}
