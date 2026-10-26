import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CommissionRates } from '../application/use-cases/commission-rates.use-case';
import type { RecordRefund } from '../application/use-cases/record-refund.use-case';
import type { RecordSellerOrderPaid } from '../application/use-cases/record-seller-order-paid.use-case';
import type { CommissionPayoutsFacade, PaidSellerOrder, RefundedSellerOrder } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class CommissionPayoutsFacadeImplementation implements CommissionPayoutsFacade {
  constructor(
    private readonly rates: CommissionRates,
    private readonly recordPaid: RecordSellerOrderPaid,
    private readonly recordRefunded: RecordRefund,
  ) {}

  commissionRates(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    return this.rates.execute(context, { sellerIds });
  }

  recordSellerOrderPaid(context: CallContext, paid: PaidSellerOrder) {
    return this.recordPaid.execute(context, paid);
  }

  recordRefund(context: CallContext, refund: RefundedSellerOrder) {
    return this.recordRefunded.execute(context, refund);
  }
}
