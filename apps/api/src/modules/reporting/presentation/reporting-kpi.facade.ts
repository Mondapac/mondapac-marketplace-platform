import { err } from '@mondapac/shared-kernel';
import type { CallContext, Clock, MarketContext, Result } from '@mondapac/shared-kernel';
import { marketDayOf } from '../domain/facts';
import { resolvePeriodRequest, type PeriodRefused, type ResolvedPeriod } from '../domain/period';
import type { ViewMarketplaceFinanceKpis } from '../application/use-cases/view-marketplace-finance-kpis.use-case';
import type { ViewMarketplaceTopCategories } from '../application/use-cases/view-marketplace-top-categories.use-case';
import type { ViewMarketplaceTopSellers } from '../application/use-cases/view-marketplace-top-sellers.use-case';
import type { ViewMarketplaceOperationsKpis } from '../application/use-cases/view-marketplace-operations-kpis.use-case';
import type {
  NetFiguresInput,
  ViewMarketplaceNetRevenue,
} from '../application/use-cases/view-marketplace-net-revenue.use-case';
import type { ViewSellerNetEarnings } from '../application/use-cases/view-seller-net-earnings.use-case';
import type { ViewMarketplaceOrderStatus } from '../application/use-cases/view-marketplace-order-status.use-case';
import type { ViewMarketplaceOrdersByState } from '../application/use-cases/view-marketplace-orders-by-state.use-case';
import type { ViewMarketplaceShoppingFunnel } from '../application/use-cases/view-marketplace-shopping-funnel.use-case';
import type { ViewMarketplaceAbandonedCarts } from '../application/use-cases/view-marketplace-abandoned-carts.use-case';
import type { KpiPeriodInput, PeriodRequest, ReportingKpiFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class ReportingKpiFacadeImplementation implements ReportingKpiFacade {
  constructor(
    private readonly operations: ViewMarketplaceOperationsKpis,
    private readonly finance: ViewMarketplaceFinanceKpis,
    private readonly topSellers: ViewMarketplaceTopSellers,
    private readonly topCategories: ViewMarketplaceTopCategories,
    private readonly netRevenue: ViewMarketplaceNetRevenue,
    private readonly netEarnings: ViewSellerNetEarnings,
    private readonly orderStatus: ViewMarketplaceOrderStatus,
    private readonly ordersByState: ViewMarketplaceOrdersByState,
    private readonly shoppingFunnel: ViewMarketplaceShoppingFunnel,
    private readonly abandonedCarts: ViewMarketplaceAbandonedCarts,
    private readonly days: {
      readonly zone: { zoneOf(market: MarketContext): string };
      readonly clock: Clock;
    },
  ) {}

  /** The period on the Market's today (zone from Market configuration); no data is read. */
  resolvePeriod(
    context: CallContext,
    period: PeriodRequest,
  ): Result<ResolvedPeriod, PeriodRefused> {
    const today = marketDayOf(this.days.clock.now(), this.days.zone.zoneOf(context.market));
    const resolved = resolvePeriodRequest(period, today);
    return resolved.ok ? resolved : err({ code: 'validation.failed', fields: resolved.error });
  }

  marketplaceOrderStatus(context: CallContext, input: KpiPeriodInput) {
    return this.orderStatus.execute(context, input);
  }

  marketplaceOrdersByState(context: CallContext, input: KpiPeriodInput) {
    return this.ordersByState.execute(context, input);
  }

  marketplaceShoppingFunnel(context: CallContext, input: KpiPeriodInput) {
    return this.shoppingFunnel.execute(context, input);
  }

  marketplaceAbandonedCarts(context: CallContext, input: KpiPeriodInput) {
    return this.abandonedCarts.execute(context, input);
  }

  marketplaceOperations(context: CallContext, input: KpiPeriodInput) {
    return this.operations.execute(context, input);
  }

  marketplaceFinance(context: CallContext, input: KpiPeriodInput) {
    return this.finance.execute(context, input);
  }

  marketplaceTopSellers(context: CallContext, input: KpiPeriodInput) {
    return this.topSellers.execute(context, input);
  }

  marketplaceTopCategories(context: CallContext, input: KpiPeriodInput) {
    return this.topCategories.execute(context, input);
  }

  marketplaceNetRevenue(context: CallContext, input: NetFiguresInput) {
    return this.netRevenue.execute(context, input);
  }

  sellerNetEarnings(context: CallContext, input: NetFiguresInput) {
    return this.netEarnings.execute(context, input);
  }
}
