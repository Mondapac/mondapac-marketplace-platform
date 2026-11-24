import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { FinanceAnswer } from '../application/use-cases/view-marketplace-finance-kpis.use-case';
import type { TopCategoriesAnswer } from '../application/use-cases/view-marketplace-top-categories.use-case';
import type { TopSellersAnswer } from '../application/use-cases/view-marketplace-top-sellers.use-case';
import type { OperationsAnswer } from '../application/use-cases/view-marketplace-operations-kpis.use-case';
import type { PeriodId } from '../domain/period';
import type {
  NetFiguresFailure,
  NetFiguresInput,
} from '../application/use-cases/view-marketplace-net-revenue.use-case';
import type { NetRevenueAnswer } from '../application/use-cases/view-marketplace-net-revenue.use-case';
import type { SellerNetEarningsAnswer } from '../application/use-cases/view-seller-net-earnings.use-case';

export type {
  FinanceKpis,
  OperationsKpis,
  TopCategoryRow,
  TopSellerRow,
} from '../domain/admin-kpi';
export type { FinanceAnswer, OperationsAnswer, PeriodId, TopCategoriesAnswer, TopSellersAnswer };
export { PERIOD_IDS, isPeriodId, resolvePeriod } from '../domain/period';
export type { DayRange } from '../domain/period';
export type {
  LedgerBackfillState,
  LedgerComponent,
  LedgerMatchDay,
  LedgerReadiness,
  LedgerReadinessReason,
  NetRevenue,
  NetRevenueComponent,
  NetRevenueTotal,
  NotAvailableReason,
  SellerNetEarnings,
} from '../domain/ledger';
export {
  MAX_RANGE_MONTHS,
  NET_REVENUE_COMPONENTS,
  READINESS_DAYS,
  READINESS_MIN_MATCHED_SELLER_ORDERS,
} from '../domain/ledger';
export type { NetFiguresFailure, NetFiguresInput, NetRevenueAnswer, SellerNetEarningsAnswer };

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

  /** The five categories with the most goods sold in the period (money: the finance key). */
  marketplaceTopCategories(
    context: CallContext,
    input: { readonly period: PeriodId },
  ): Promise<Result<TopCategoriesAnswer, AccessDenied>>;

  /**
   * Mondapac's net revenue of a range of Market days, without GST, with the "matching ledger"
   * readiness (FE-066): `netRevenue` is null until it is ready, a component with no source is
   * `not-available`, never 0, and `total` has an amount only when every component has one
   * (`partial` lists the missing ones instead). Key `commission-payouts.settlement.view`, platform admin only.
   */
  marketplaceNetRevenue(
    context: CallContext,
    input: NetFiguresInput,
  ): Promise<Result<NetRevenueAnswer, NetFiguresFailure>>;

  /**
   * The session seller's own net earnings of a range of Market days, without GST; null until the
   * Market's ledger is ready. Key `commission-payouts.earnings.view`, the session's seller only.
   */
  sellerNetEarnings(
    context: CallContext,
    input: NetFiguresInput,
  ): Promise<Result<SellerNetEarningsAnswer, NetFiguresFailure>>;
}

/** Nest token of the {@link ReportingKpiFacade}, provided and exported by `ReportingModule`. */
export const REPORTING_KPI_FACADE = Symbol('REPORTING_KPI_FACADE');
