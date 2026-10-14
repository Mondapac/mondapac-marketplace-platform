import { ApiProperty } from '@nestjs/swagger';

// Bodies of the flat-fee routes. Ids and minor-unit strings only.

export class FlatFeeBody {
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ description: 'Minor units as a string of digits; zero means free shipping.' })
  amount!: string;
  @ApiProperty({ description: 'ISO 4217, the Market currency.' }) currency!: string;
}

export class SetFlatFeeRequest {
  @ApiProperty({
    description: 'Minor units, a whole number from 0 to 100000 (a number or a string of digits).',
    example: 995,
  })
  amount!: number | string;
}
