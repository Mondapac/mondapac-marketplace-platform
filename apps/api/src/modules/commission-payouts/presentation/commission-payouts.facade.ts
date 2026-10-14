import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { CommissionRates } from '../application/use-cases/commission-rates.use-case';
import type { RecordSellerOrderPaid } from '../application/use-cases/record-seller-order-paid.use-case';
import type { CommissionPayoutsFacade, PaidSellerOrder } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class CommissionPayoutsFacadeImplementation implements CommissionPayoutsFacade {
  constructor(
    private readonly rates: CommissionRates,
    private readonly recordPaid: RecordSellerOrderPaid,
  ) {}

  commissionRates(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    return this.rates.execute(context, { sellerIds });
  }

  recordSellerOrderPaid(context: CallContext, paid: PaidSellerOrder) {
    return this.recordPaid.execute(context, paid);
  }
}
