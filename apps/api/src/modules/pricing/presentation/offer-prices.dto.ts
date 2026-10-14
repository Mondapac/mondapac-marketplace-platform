import { ApiProperty } from '@nestjs/swagger';

// Answer of the seller offer-prices route. Ids, codes and minor-unit strings only; no Cost.

export class InForcePriceBody {
  @ApiProperty({ description: 'Minor units as a string of digits.', example: '1999' })
  amount!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  effectiveFrom!: string;
}

export class HeldPriceBody {
  @ApiProperty({ description: 'Minor units as a string of digits.', example: '2999' })
  amount!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  submittedAt!: string;

  @ApiProperty({ enum: ['up', 'down'] })
  direction!: 'up' | 'down';
}

export class SpecialPriceBody {
  @ApiProperty({ description: 'Minor units as a string of digits.', example: '1499' })
  amount!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  endsAt!: string;

  @ApiProperty({ enum: ['running', 'scheduled'] })
  state!: 'running' | 'scheduled';
}

export class HeldSpecialBody {
  @ApiProperty({ description: 'Minor units as a string of digits.', example: '1499' })
  amount!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  endsAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  submittedAt!: string;
}

export class VariantPriceBody {
  @ApiProperty({ type: String, format: 'uuid' })
  variantId!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Send as expectedVersion with the next write; null when no price exists yet.',
  })
  seriesVersion!: number | null;

  @ApiProperty({ type: String, nullable: true })
  currency!: string | null;

  @ApiProperty({ type: InForcePriceBody, nullable: true })
  inForce!: InForcePriceBody | null;

  @ApiProperty({ type: HeldPriceBody, nullable: true })
  held!: HeldPriceBody | null;

  @ApiProperty({ type: SpecialPriceBody, nullable: true })
  special!: SpecialPriceBody | null;

  @ApiProperty({ type: HeldSpecialBody, nullable: true })
  heldSpecial!: HeldSpecialBody | null;

  @ApiProperty({ description: 'The series stopped taking prices; read only.' })
  retired!: boolean;
}

export class OfferPricesBody {
  @ApiProperty({ type: String, format: 'uuid' })
  offerId!: string;

  @ApiProperty({ description: 'The Market currency (ISO 4217) every price is written in.' })
  currency!: string;

  @ApiProperty({ type: [VariantPriceBody] })
  variants!: VariantPriceBody[];
}
