import { ApiProperty } from '@nestjs/swagger';
import type { RefundView } from '../application/use-cases/admin-refund-order.use-case';
import { LOSS_BEARERS, LOSS_REASON_CODES, REFUND_REASONS } from '../domain/refund';
import { moneyBody } from './http-answers';
import { MoneyView } from './orders.dto';

// Bodies and answers of the refund routes (tax step 3). Ids, codes, minor-unit strings and
// instants only.

export class RefundLineRequest {
  @ApiProperty({ format: 'uuid' }) orderLineId!: string;
  @ApiProperty({ description: 'Units of the line to give back, 1 up to what is left.' })
  quantity!: number;
}

export class RefundRequestBody {
  @ApiProperty({ type: [RefundLineRequest], required: false, description: 'At most 200 lines.' })
  lines?: RefundLineRequest[];
  @ApiProperty({
    required: false,
    description: 'Part or all of the shipping fee to give back (tax included), minor units.',
    example: '550',
  })
  shippingAmount?: string;
  @ApiProperty({ enum: REFUND_REASONS }) reason!: string;
  @ApiProperty({
    enum: LOSS_BEARERS,
    required: false,
    default: 'seller',
    description:
      'Who bears the loss. seller: the refund is reversed in the seller ledger. platform: the ' +
      'seller keeps its full share and nothing is posted; lossReasonCode is then required.',
  })
  lossBearer?: string;
  @ApiProperty({
    enum: LOSS_REASON_CODES,
    required: false,
    description: 'Required when lossBearer is platform, and refused otherwise.',
  })
  lossReasonCode?: string;
}

export class RefundLineBody {
  @ApiProperty({ format: 'uuid' }) orderLineId!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty({ type: MoneyView, description: 'Given back for these units, tax included.' })
  amount!: MoneyView;
  @ApiProperty({ type: MoneyView, description: 'The tax reversed, from the frozen line tax.' })
  tax!: MoneyView;
  @ApiProperty() taxRateBps!: number;
  @ApiProperty() taxInclusive!: boolean;
}

export class RefundShippingBody {
  @ApiProperty({ type: MoneyView }) amount!: MoneyView;
  @ApiProperty({ type: MoneyView }) tax!: MoneyView;
}

export class RefundBody {
  @ApiProperty({ format: 'uuid' }) refundId!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'uuid' }) sellerOrderId!: string;
  @ApiProperty({
    enum: ['pending', 'succeeded'],
    description: 'pending: Stripe did not answer yet; the worker retries with the same key.',
  })
  state!: string;
  @ApiProperty({ enum: REFUND_REASONS }) reason!: string;
  @ApiProperty({ enum: LOSS_BEARERS }) lossBearer!: string;
  @ApiProperty({ enum: LOSS_REASON_CODES, nullable: true, type: String })
  lossReasonCode!: string | null;
  @ApiProperty({ type: MoneyView }) amount!: MoneyView;
  @ApiProperty({ type: MoneyView }) tax!: MoneyView;
  @ApiProperty({ type: RefundShippingBody, nullable: true }) shipping!: RefundShippingBody | null;
  @ApiProperty({ type: [RefundLineBody] }) lines!: RefundLineBody[];
  @ApiProperty({ format: 'date-time' }) requestedAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true }) settledAt!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, description: 'Set once the refund succeeded.' })
  creditNoteId!: string | null;
}

export const REFUND_BODY_KEYS = [
  'lines',
  'shippingAmount',
  'reason',
  'lossBearer',
  'lossReasonCode',
] as const;

export const refundBody = (refund: RefundView): RefundBody => ({
  refundId: refund.refundId,
  orderId: refund.orderId,
  sellerOrderId: refund.sellerOrderId,
  state: refund.state,
  reason: refund.reason,
  lossBearer: refund.lossBearer,
  lossReasonCode: refund.lossReasonCode,
  amount: moneyBody(refund.amount),
  tax: moneyBody(refund.tax),
  shipping:
    refund.shipping === null
      ? null
      : { amount: moneyBody(refund.shipping.amount), tax: moneyBody(refund.shipping.tax) },
  lines: refund.lines.map((line) => ({
    orderLineId: line.orderLineId,
    quantity: line.quantity,
    amount: moneyBody(line.amount),
    tax: moneyBody(line.tax),
    taxRateBps: line.taxRateBps,
    taxInclusive: line.taxInclusive,
  })),
  requestedAt: refund.requestedAt.toString(),
  settledAt: refund.settledAt === null ? null : refund.settledAt.toString(),
  creditNoteId: refund.creditNoteId,
});
