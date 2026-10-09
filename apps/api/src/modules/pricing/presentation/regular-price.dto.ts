import { ApiProperty } from '@nestjs/swagger';

// Body and answer of the seller regular-price route. Ids, codes and minor-unit strings only.

export class RegularPriceRequest {
  @ApiProperty({
    description: 'Minor units as a string of digits, no sign, no leading zeros, at most 16 digits.',
    example: '1999',
  })
  amount!: string;

  @ApiProperty({
    description: "The Market's currency (ISO 4217). Any other is refused.",
  })
  currency!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'The series version the screen showed, or null when it showed no price. A mismatch is conflict.stale.',
  })
  expectedVersion!: number | null;
}

export class RegularPriceWritten {
  @ApiProperty({
    enum: ['accepted', 'pending-review', 'unchanged'],
    description: 'pending-review: the jump is held for review (a success, not an error).',
  })
  status!: 'accepted' | 'pending-review' | 'unchanged';

  @ApiProperty({ description: 'Send this as expectedVersion with the next write.' })
  seriesVersion!: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  recordId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  effectiveFrom!: string | null;
}
