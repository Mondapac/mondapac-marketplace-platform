import { ApiProperty } from '@nestjs/swagger';

// Answer of the seller receive-estimates route (Offer page PR 4). Minor-unit strings; never the
// commission rate.

export class ReceiveEstimateLineBody {
  @ApiProperty({ format: 'uuid' })
  variantId!: string;

  @ApiProperty({ description: 'The price asked about, minor units.', example: '1590' })
  priceMinor!: string;

  @ApiProperty({
    description: 'The most the commission can be on that price, minor units.',
    example: '239',
  })
  commissionMinor!: string;

  @ApiProperty({
    description:
      'What the ledger credits the seller for one unit, before delivery: the price less the commission. It includes the tax the seller owes when `taxInclusive`.',
    example: '1351',
  })
  youReceiveMinor!: string;
}

export class ReceiveEstimatesBody {
  @ApiProperty({ format: 'uuid' })
  offerId!: string;

  @ApiProperty({ description: 'The Market currency, ISO 4217.' })
  currency!: string;

  @ApiProperty({ description: "The Market's price convention: prices include tax." })
  taxInclusive!: boolean;

  @ApiProperty({ type: [ReceiveEstimateLineBody] })
  lines!: ReceiveEstimateLineBody[];
}
