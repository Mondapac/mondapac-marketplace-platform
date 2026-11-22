import type { CallContext } from '@mondapac/shared-kernel';
import type { ViewMarketplaceFinanceKpis } from '../application/use-cases/view-marketplace-finance-kpis.use-case';
import type { ViewMarketplaceTopCategories } from '../application/use-cases/view-marketplace-top-categories.use-case';
import type { ViewMarketplaceTopSellers } from '../application/use-cases/view-marketplace-top-sellers.use-case';
import type { ViewMarketplaceOperationsKpis } from '../application/use-cases/view-marketplace-operations-kpis.use-case';
import type { PeriodId, ReportingKpiFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class ReportingKpiFacadeImplementation implements ReportingKpiFacade {
  constructor(
    private readonly operations: ViewMarketplaceOperationsKpis,
    private readonly finance: ViewMarketplaceFinanceKpis,
    private readonly topSellers: ViewMarketplaceTopSellers,
    private readonly topCategories: ViewMarketplaceTopCategories,
  ) {}

  marketplaceOperations(context: CallContext, input: { readonly period: PeriodId }) {
    return this.operations.execute(context, input);
  }

  marketplaceFinance(context: CallContext, input: { readonly period: PeriodId }) {
    return this.finance.execute(context, input);
  }

  marketplaceTopSellers(context: CallContext, input: { readonly period: PeriodId }) {
    return this.topSellers.execute(context, input);
  }

  marketplaceTopCategories(context: CallContext, input: { readonly period: PeriodId }) {
    return this.topCategories.execute(context, input);
  }
}
