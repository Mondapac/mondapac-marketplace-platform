import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { FinanceAnswer } from '../application/use-cases/view-marketplace-finance-kpis.use-case';
import type { TopSellersAnswer } from '../application/use-cases/view-marketplace-top-sellers.use-case';
import type { OperationsAnswer } from '../application/use-cases/view-marketplace-operations-kpis.use-case';
import type { PeriodId } from '../domain/period';

export type { FinanceKpis, OperationsKpis, TopSellerRow } from '../domain/admin-kpi';
export type { FinanceAnswer, OperationsAnswer, PeriodId, TopSellersAnswer };
export { PERIOD_IDS, isPeriodId } from '../domain/period';

/**
 * The marketplace KPIs of the admin dashboard (dashboards upgrade, phase 5). Each method runs one
 * use case with the caller's `CallContext` unchanged, so its owner checks its own key: the
 * operations read needs `ordering.order.view`, the finance read `commission-payouts.settlement.view`.
 * Not exposed over HTTP; the dashboard module composes them.
 */
export interface ReportingKpiFacade {
  marketplaceOperations(
    context: CallContext,
    input: { readonly period: PeriodId },
  ): Promise<Result<OperationsAnswer, AccessDenied>>;

  marketplaceFinance(
    context: CallContext,
    input: { readonly period: PeriodId },
  ): Promise<Result<FinanceAnswer, AccessDenied>>;

  /** The five sellers with the most goods sold in the period (money: the finance key). */
  marketplaceTopSellers(
    context: CallContext,
    input: { readonly period: PeriodId },
  ): Promise<Result<TopSellersAnswer, AccessDenied>>;
}

/** Nest token of the {@link ReportingKpiFacade}, provided and exported by `ReportingModule`. */
export const REPORTING_KPI_FACADE = Symbol('REPORTING_KPI_FACADE');
