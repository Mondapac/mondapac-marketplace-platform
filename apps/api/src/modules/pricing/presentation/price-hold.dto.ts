import { ApiProperty } from '@nestjs/swagger';
import { HOLD_REJECTION_REASONS } from '../domain/price-series';

// Bodies and answers of the admin price-hold review routes. Ids, codes, minor-unit strings and
// instants, plus three display names (product name, Variant label, public store name): no Cost,
// no submitter, no legal name or address.

export class HoldMoney {
  @ApiProperty({
    description: 'Minor units of the currency, as a string of digits.',
    example: '1999',
  })
  amount!: string;

  @ApiProperty({ description: 'ISO 4217 currency of the Market.' })
  currency!: string;
}

export class HoldWindow {
  @ApiProperty({ format: 'date-time' })
  startsAt!: string;

  @ApiProperty({ format: 'date-time' })
  endsAt!: string;
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

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The published product name (seller text; escape it). Null when unknown or the lookup failed.',
  })
  productName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The published Variant label. Null when there is none or the lookup failed.',
  })
  variantLabel!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      "The seller's public store name (approved revision only). Null when unknown or the lookup failed.",
  })
  storeName!: string | null;

  @ApiProperty({ enum: ['regular', 'special'] })
  kind!: 'regular' | 'special';

  @ApiProperty({
    type: HoldWindow,
    required: false,
    description: 'The window the seller asked for; present for a special price only.',
  })
  window?: HoldWindow;

  @ApiProperty({ type: HoldMoney, description: 'The held price.' })
  amount!: HoldMoney;

  @ApiProperty({
    type: HoldMoney,
    description:
      'The price it was measured against. For a special: the larger of the regular price and ' +
      'the regular jump anchor.',
  })
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

  @ApiProperty({ description: "Every pending record of the Market, whatever the page." })
  total!: number;
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
