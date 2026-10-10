import { ApiProperty } from '@nestjs/swagger';
import { HOLD_REJECTION_REASONS } from '../domain/price-series';

// Bodies and answers of the admin price-hold review routes. Ids, codes, minor-unit strings and
// instants only: no Cost, no submitter, no seller data beyond the seller id.

export class HoldMoney {
  @ApiProperty({
    description: 'Minor units of the currency, as a string of digits.',
    example: '1999',
  })
  amount!: string;

  @ApiProperty({ description: 'ISO 4217 currency of the Market.' })
  currency!: string;
}

export class PriceHoldRow {
  @ApiProperty({ format: 'uuid', description: 'The record to approve or reject.' })
  recordId!: string;

  @ApiProperty({ format: 'uuid' })
  offerId!: string;

  @ApiProperty({ format: 'uuid' })
  variantId!: string;

  @ApiProperty({ format: 'uuid' })
  sellerId!: string;

  @ApiProperty({ enum: ['regular'], description: 'Special prices join with their slice.' })
  kind!: 'regular';

  @ApiProperty({ type: HoldMoney, description: 'The held price.' })
  amount!: HoldMoney;

  @ApiProperty({ type: HoldMoney, description: 'The price it was measured against.' })
  anchorAmount!: HoldMoney;

  @ApiProperty({ enum: ['up', 'down'] })
  direction!: 'up' | 'down';

  @ApiProperty({ format: 'date-time' })
  submittedAt!: string;
}

export class PriceHoldPageBody {
  @ApiProperty({ type: [PriceHoldRow], description: 'Oldest submission first.' })
  items!: PriceHoldRow[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Send as the `after` query parameter for the next page; null after the last.',
  })
  next!: string | null;
}

export class RejectPriceHoldRequest {
  @ApiProperty({ enum: HOLD_REJECTION_REASONS, description: 'Required.' })
  reasonCode!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    maxLength: 1000,
    description:
      'Optional free text the seller reads. Personal data: kept on the record, never in the ' +
      'audit log, an event or a log line.',
  })
  note?: string | null;
}

export class PriceHoldApproved {
  @ApiProperty({ format: 'uuid' })
  recordId!: string;

  @ApiProperty({ enum: ['approved'] })
  outcome!: 'approved';

  @ApiProperty({ format: 'date-time', description: 'From approval, never from submission.' })
  effectiveFrom!: string;

  @ApiProperty()
  seriesVersion!: number;
}

export class PriceHoldRejected {
  @ApiProperty({ format: 'uuid' })
  recordId!: string;

  @ApiProperty({ enum: ['rejected'] })
  outcome!: 'rejected';

  @ApiProperty()
  seriesVersion!: number;
}
