import { err } from '@mondapac/shared-kernel';
import type { CallContext, Clock, MarketContext, Result } from '@mondapac/shared-kernel';
import { marketDayOf } from '../domain/facts';
import { resolvePeriodRequest, type PeriodRefused, type ResolvedPeriod } from '../domain/period';
import type { ViewMarketplaceFinanceKpis } from '../application/use-cases/view-marketplace-finance-kpis.use-case';
import type { ViewMarketplaceTopCategories } from '../application/use-cases/view-marketplace-top-categories.use-case';
import type { ViewMarketplaceTopSellers } from '../application/use-cases/view-marketplace-top-sellers.use-case';
import type { ViewMarketplaceOperationsKpis } from '../application/use-cases/view-marketplace-operations-kpis.use-case';
import type { KpiPeriodInput, PeriodRequest, ReportingKpiFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class ReportingKpiFacadeImplementation implements ReportingKpiFacade {
  constructor(
    private readonly operations: ViewMarketplaceOperationsKpis,
    private readonly finance: ViewMarketplaceFinanceKpis,
    private readonly topSellers: ViewMarketplaceTopSellers,
    private readonly topCategories: ViewMarketplaceTopCategories,
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
}
