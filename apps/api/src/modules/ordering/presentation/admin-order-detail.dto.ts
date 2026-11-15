import { ApiProperty } from '@nestjs/swagger';
import type { AdminOrderDetailView } from '../application/use-cases/admin-view-order.use-case';
import { AdminOrderBody, adminOrderBody } from './orders.dto';
import { RefundBody, refundBody } from './refunds.dto';

/** The admin order page's answer: the order, its refunds and the refund switch. */
export class AdminOrderDetailBody extends AdminOrderBody {
  @ApiProperty({
    type: [RefundBody],
    description:
      'Every refund of the order, oldest first, in any state (pending, succeeded, failed).',
  })
  refunds!: RefundBody[];
  @ApiProperty({
    description:
      'The Market switch tax.refundCredit.enabled. Off, refunds and the cancellation answer 409 ' +
      'ordering.refund-disabled.',
  })
  refundsEnabled!: boolean;
}

export const adminOrderDetailBody = (order: AdminOrderDetailView): AdminOrderDetailBody => ({
  ...adminOrderBody(order),
  refunds: order.refunds.map(refundBody),
  refundsEnabled: order.refundsEnabled,
});
