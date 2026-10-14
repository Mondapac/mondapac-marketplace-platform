import { ApiProperty } from '@nestjs/swagger';

// Bodies and answers of the seller special-price routes. Ids, codes, minor-unit strings and UTC
// instants only.

export class SpecialPriceRequest {
  @ApiProperty({
    description: 'Minor units as a string of digits, no sign, no leading zeros, at most 16 digits.',
    example: '1499',
  })
  amount!: string;

  @ApiProperty({ description: "The Market's currency (ISO 4217). Any other is refused." })
  currency!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    example: '2026-10-20T01:00:00Z',
    description:
      'UTC instant (Z, at most milliseconds) the special starts; null or absent starts it now. ' +
      'Not in the past.',
  })
  startsAt?: string | null;

  @ApiProperty({
    example: '2026-10-27T13:59:59Z',
    description: 'UTC instant the special ends; after the start.',
  })
  endsAt!: string;

  @ApiProperty({
    description: 'The series version the screen showed (the regular price write answers it).',
  })
  expectedVersion!: number;
}

export class SpecialPriceWritten {
  @ApiProperty({
    enum: ['accepted', 'pending-review'],
    description: 'pending-review: the discount is held for review (a success, not an error).',
  })
  status!: 'accepted' | 'pending-review';

  @ApiProperty({ description: 'Send this as expectedVersion with the next write.' })
  seriesVersion!: number;

  @ApiProperty({ format: 'uuid' })
  recordId!: string;

  @ApiProperty({ format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ format: 'date-time' })
  endsAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  effectiveFrom!: string | null;
}

export class WithdrawSpecialPriceRequest {
  @ApiProperty({ description: 'The series version the screen showed.' })
  expectedVersion!: number;
}

export class SpecialPriceWithdrawn {
  @ApiProperty({ description: 'Send this as expectedVersion with the next write.' })
  seriesVersion!: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The running or scheduled special that was ended now.',
  })
  endedRecordId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The special that waited for review and was cancelled.',
  })
  cancelledRecordId!: string | null;
}
