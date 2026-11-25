import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import type { CheckoutsStartedQuery } from '../application/use-cases/checkouts-started.use-case';
import type { RefundReportFactsQuery } from '../application/use-cases/refund-report-facts.use-case';
import type { RefundsSucceededQuery } from '../application/use-cases/refunds-succeeded.use-case';
import type { SellerOrdersChangedQuery } from '../application/use-cases/seller-orders-changed.use-case';
import type { SellerOrderReportFactsQuery } from '../application/use-cases/seller-order-report-facts.use-case';
import type {
  OrderingReportingFacade,
  ReportWindow,
  SellerOrderQuery,
} from '../contracts/ordering-reporting.facade';

/** Passes the caller's `CallContext` unchanged to one use case each, so the gate runs. */
export class OrderingReportingFacadeImplementation implements OrderingReportingFacade {
  constructor(
    private readonly sellerOrderFacts: SellerOrderReportFactsQuery,
    private readonly refundFacts: RefundReportFactsQuery,
    private readonly sellerOrders: SellerOrdersChangedQuery,
    private readonly refunds: RefundsSucceededQuery,
    private readonly checkouts: CheckoutsStartedQuery,
  ) {}

  sellerOrderReportFacts(
    context: CallContext,
    request: { readonly sellerOrders: readonly SellerOrderQuery[] },
  ) {
    return this.sellerOrderFacts.execute(context, request);
  }

  refundReportFacts(
    context: CallContext,
    request: { readonly refundIds: readonly Id<'Refund'>[] },
  ) {
    return this.refundFacts.execute(context, request);
  }

  sellerOrdersChanged(
    context: CallContext,
    request: {
      readonly window: ReportWindow;
      readonly after: string | null;
      readonly limit: number;
    },
  ) {
    return this.sellerOrders.execute(context, request);
  }

  refundsSucceeded(
    context: CallContext,
    request: {
      readonly window: ReportWindow;
      readonly after: string | null;
      readonly limit: number;
    },
  ) {
    return this.refunds.execute(context, request);
  }

  checkoutsStarted(
    context: CallContext,
    request: {
      readonly window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant };
    },
  ) {
    return this.checkouts.execute(context, request);
  }
}
