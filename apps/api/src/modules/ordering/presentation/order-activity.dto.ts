import { ApiProperty } from '@nestjs/swagger';
import type { OrderActivityView } from '../application/use-cases/admin-view-order-activity.use-case';
import type { OrderActivityEvent } from '../domain/order-activity';
import { MoneyView } from './orders.dto';
import { moneyBody } from './http-answers';

const KINDS = [
  'order-placed',
  'order-paid',
  'order-cancelled',
  'seller-order-ready',
  'seller-order-shipped',
  'seller-order-delivered',
  'seller-order-collected',
  'refund-requested',
  'refund-succeeded',
  'refund-failed',
] as const;

export class OrderActivityEventBody {
  @ApiProperty({ enum: KINDS }) kind!: (typeof KINDS)[number];
  @ApiProperty({ format: 'date-time', description: 'A UTC instant.' }) at!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) sellerOrderId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) refundId!: string | null;
  @ApiProperty({
    type: MoneyView,
    nullable: true,
    description: "A refund's amount, tax included; null for any other event.",
  })
  amount!: MoneyView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The refund reason or the cancel reason (closed lists); null otherwise.',
  })
  reason!: string | null;
  @ApiProperty({
    type: String,
    enum: ['customer', 'seller', 'admin'],
    nullable: true,
    description: 'Who did it, when known; null for the platform or a carrier.',
  })
  by!: 'customer' | 'seller' | 'admin' | null;
}

export class OrderActivityBody {
  @ApiProperty({ type: [OrderActivityEventBody], description: 'Oldest first.' })
  events!: OrderActivityEventBody[];
}

const eventBody = (event: OrderActivityEvent): OrderActivityEventBody => ({
  kind: event.kind,
  at: event.at.toString(),
  sellerOrderId: event.sellerOrderId,
  refundId: event.refundId,
  amount: event.amount === null ? null : moneyBody(event.amount),
  reason: event.reason,
  by: event.by,
});

export const orderActivityBody = (view: OrderActivityView): OrderActivityBody => ({
  events: view.events.map(eventBody),
});
