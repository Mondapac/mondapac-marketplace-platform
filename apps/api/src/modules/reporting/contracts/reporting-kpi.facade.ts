import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { FinanceAnswer } from '../application/use-cases/view-marketplace-finance-kpis.use-case';
import type { TopCategoriesAnswer } from '../application/use-cases/view-marketplace-top-categories.use-case';
import type { TopSellersAnswer } from '../application/use-cases/view-marketplace-top-sellers.use-case';
import type { OperationsAnswer } from '../application/use-cases/view-marketplace-operations-kpis.use-case';
import type {
  PeriodFieldRefusal,
  PeriodId,
  PeriodRefused,
  PeriodRequest,
  ResolvedPeriod,
} from '../domain/period';

export type {
  FinanceKpis,
  OperationsKpis,
  TopCategoryRow,
  TopSellerRow,
} from '../domain/admin-kpi';
export type {
  FinanceAnswer,
  OperationsAnswer,
  PeriodFieldRefusal,
  PeriodId,
  PeriodRefused,
  PeriodRequest,
  ResolvedPeriod,
  TopCategoriesAnswer,
  TopSellersAnswer,
};
export {
  MAX_RANGE_DAYS,
  MAX_RANGE_MONTHS,
  PERIOD_IDS,
  isPeriodId,
  parsePeriodQuery,
} from '../domain/period';

/** Why a KPI read refused: access, or a custom range that ends after the Market's today. */
export type KpiFailure = AccessDenied | PeriodRefused;

/** The input of every marketplace KPI read: a preset or a custom range (`parsePeriodQuery`). */
export interface KpiPeriodInput {
  readonly period: PeriodRequest;
}

/**
 * The marketplace KPIs of the admin dashboard (dashboards upgrade, phase 5). Each method runs one
 * use case with the caller's `CallContext` unchanged, so its owner checks its own key: the
 * operations read needs `ordering.order.view`, the finance read `commission-payouts.settlement.view`.
 * Not exposed over HTTP; the dashboard module composes them. A custom range that ends after the
 * Market's today is `validation.failed` (dashboards v2, PR 5).
 */
export interface ReportingKpiFacade {
  /**
   * The Market days of a period on the Market's today (no data is read, so no key): what the
   * dashboard checks before it asks any section, so a range that ends in the future is one 400.
   */
  resolvePeriod(context: CallContext, period: PeriodRequest): Result<ResolvedPeriod, PeriodRefused>;

  marketplaceOperations(
    context: CallContext,
    input: KpiPeriodInput,
  ): Promise<Result<OperationsAnswer, KpiFailure>>;

  marketplaceFinance(
    context: CallContext,
    input: KpiPeriodInput,
  ): Promise<Result<FinanceAnswer, KpiFailure>>;

  /** The five sellers with the most goods sold in the period (money: the finance key). */
  marketplaceTopSellers(
    context: CallContext,
    input: KpiPeriodInput,
  ): Promise<Result<TopSellersAnswer, KpiFailure>>;

  /** The five categories with the most goods sold in the period (money: the finance key). */
  marketplaceTopCategories(
    context: CallContext,
    input: KpiPeriodInput,
  ): Promise<Result<TopCategoriesAnswer, KpiFailure>>;
}

/** Nest token of the {@link ReportingKpiFacade}, provided and exported by `ReportingModule`. */
export const REPORTING_KPI_FACADE = Symbol('REPORTING_KPI_FACADE');
