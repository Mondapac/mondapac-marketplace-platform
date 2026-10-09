import { ApiProperty } from '@nestjs/swagger';

// Bodies and answers of the cart routes. Ids, codes and minor-unit strings only.

export class MoneyView {
  @ApiProperty({ description: 'Minor units as a string of digits.', example: '1999' })
  amount!: string;

  @ApiProperty({ description: 'ISO 4217, the Market currency.' })
  currency!: string;
}

export class AddItemRequest {
  @ApiProperty({ format: 'uuid' })
  offerId!: string;

  @ApiProperty({ format: 'uuid' })
  variantId!: string;

  @ApiProperty({
    description: 'A whole number from 1. Limited to the Market maximum or what is left.',
  })
  quantity!: number;
}

export class SetQuantityRequest {
  @ApiProperty({ description: 'The new quantity, a whole number from 1.' })
  quantity!: number;
}

export class LineWrittenView {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  lineId!: string | null;

  @ApiProperty()
  quantity!: number;

  @ApiProperty({ description: 'False when the request changed nothing.' })
  changed!: boolean;

  @ApiProperty({
    enum: ['market-ceiling', 'only-left'],
    nullable: true,
    description: 'Set when the quantity was limited.',
  })
  clamped!: 'market-ceiling' | 'only-left' | null;
}

export class AvailabilityView {
  @ApiProperty({ enum: ['in-stock', 'low', 'out'] })
  status!: 'in-stock' | 'low' | 'out';

  @ApiProperty({ type: Number, nullable: true })
  onlyLeft!: number | null;
}

export class CartLineView {
  @ApiProperty({ format: 'uuid' }) lineId!: string;
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty() quantity!: number;

  @ApiProperty({
    enum: ['buyable', 'unavailable', 'check-unavailable'],
    description: 'check-unavailable: a check failed, so the line is not buyable right now.',
  })
  state!: 'buyable' | 'unavailable' | 'check-unavailable';

  @ApiProperty({
    enum: ['offer-unavailable', 'seller-not-eligible', 'no-valid-price', 'out-of-stock'],
    nullable: true,
  })
  reason!: string | null;

  @ApiProperty({ type: MoneyView, nullable: true })
  unitPrice!: MoneyView | null;

  @ApiProperty({
    type: MoneyView,
    nullable: true,
    description: 'The price when the line was added, when the price has changed since.',
  })
  previousPrice!: MoneyView | null;

  @ApiProperty({ type: AvailabilityView, nullable: true })
  availability!: AvailabilityView | null;
}

export class SellerGroupView {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  sellerId!: string | null;

  @ApiProperty({ type: MoneyView, nullable: true })
  subtotal!: MoneyView | null;

  @ApiProperty({ type: [CartLineView] })
  lines!: CartLineView[];
}

export class CartViewBody {
  @ApiProperty({ type: [SellerGroupView] })
  groups!: SellerGroupView[];

  @ApiProperty()
  lineCount!: number;
}

export class RemovedView {
  @ApiProperty()
  removed!: true;
}

export class MergedView {
  @ApiProperty()
  merged!: boolean;

  @ApiProperty({ type: [Object], description: 'Lines whose quantity was limited.' })
  clamped!: { offerId: string; variantId: string; clamped: 'market-ceiling' | 'only-left' }[];

  @ApiProperty({ type: [Object], description: 'Guest lines left out: the cart is full.' })
  notAdded!: { offerId: string; variantId: string }[];
}
