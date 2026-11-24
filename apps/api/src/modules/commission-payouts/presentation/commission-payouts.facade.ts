import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { CommissionRates } from '../application/use-cases/commission-rates.use-case';
import type { OwnCommissionOn } from '../application/use-cases/own-commission-on.use-case';
import type { RecordSellerOrderDelivered } from '../application/use-cases/record-seller-order-delivered.use-case';
import type { RecordRefund } from '../application/use-cases/record-refund.use-case';
import type { RecordSellerOrderPaid } from '../application/use-cases/record-seller-order-paid.use-case';
import type { RecordSellerCashback } from '../application/use-cases/record-seller-cashback.use-case';
import type { RecordSellerCashbackReturn } from '../application/use-cases/record-seller-cashback-return.use-case';
import type { SellerOrderPayoutAnchorQuery } from '../application/use-cases/seller-order-payout-anchor.use-case';
import type { SellerLostDisputes } from '../application/use-cases/seller-lost-disputes.use-case';
import type {
  CommissionPayoutsFacade,
  ExclusiveBuyer,
  PaidSellerOrder,
  RefundedSellerOrder,
  SellerCashback,
  SellerCashbackReturn,
  SellerOrderDelivered,
} from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class CommissionPayoutsFacadeImplementation implements CommissionPayoutsFacade {
  constructor(
    private readonly rates: CommissionRates,
    private readonly recordPaid: RecordSellerOrderPaid,
    private readonly recordRefunded: RecordRefund,
    private readonly recordDelivered: RecordSellerOrderDelivered,
    private readonly lostDisputes: SellerLostDisputes,
    private readonly ownCommission: OwnCommissionOn,
    private readonly recordCashback: RecordSellerCashback,
    private readonly payoutAnchor: SellerOrderPayoutAnchorQuery,
    private readonly recordCashbackReturn: RecordSellerCashbackReturn,
  ) {}

  recordSellerCashbackReturn(context: CallContext, returned: SellerCashbackReturn) {
    return this.recordCashbackReturn.execute(context, returned);
  }

  sellerOrderPayoutAnchor(context: CallContext, sellerOrderId: Id<'SellerOrder'>) {
    return this.payoutAnchor.execute(context, sellerOrderId);
  }

  recordSellerCashback(context: CallContext, cashback: SellerCashback) {
    return this.recordCashback.execute(context, cashback);
  }

  commissionRates(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
    exclusive: ExclusiveBuyer | null = null,
  ) {
    return this.rates.execute(context, { sellerIds, exclusive });
  }

  ownCommissionOn(
    context: CallContext,
    request: {
      readonly amount: bigint;
      readonly taxInclusive: boolean;
      readonly taxRateBps?: number;
    },
  ) {
    return this.ownCommission.execute(context, request);
  }

  recordSellerOrderPaid(context: CallContext, paid: PaidSellerOrder) {
    return this.recordPaid.execute(context, paid);
  }

  recordRefund(context: CallContext, refund: RefundedSellerOrder) {
    return this.recordRefunded.execute(context, refund);
  }

  recordSellerOrderDelivered(context: CallContext, delivered: SellerOrderDelivered) {
    return this.recordDelivered.execute(context, delivered);
  }

  sellerLostDisputes(
    context: CallContext,
    sellerId: Id<'Seller'>,
    windows: readonly { readonly from: Temporal.Instant; readonly to: Temporal.Instant }[],
  ) {
    return this.lostDisputes.execute(context, {
      sellerId,
      windows: windows.map((w) => ({ from: w.from.toString(), to: w.to.toString() })),
    });
  }
}
