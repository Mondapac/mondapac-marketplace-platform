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
import type {
  NetFiguresFailure,
  NetFiguresInput,
} from '../application/use-cases/view-marketplace-net-revenue.use-case';
import type { NetRevenueAnswer } from '../application/use-cases/view-marketplace-net-revenue.use-case';
import type { SellerNetEarningsAnswer } from '../application/use-cases/view-seller-net-earnings.use-case';
import type { OrdersByStateAnswer } from '../application/use-cases/view-marketplace-orders-by-state.use-case';
import type { ShoppingFunnelAnswer } from '../application/use-cases/view-marketplace-shopping-funnel.use-case';
import type { OrderStatusAnswer } from '../application/use-cases/view-marketplace-order-status.use-case';
import type { MonthlyTargetAnswer } from '../application/use-cases/view-marketplace-monthly-target.use-case';
import type { FinanceNet } from '../application/use-cases/view-marketplace-finance-kpis.use-case';

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
  NET_REVENUE_COMPONENTS,
  READINESS_DAYS,
  READINESS_MIN_MATCHED_SELLER_ORDERS,
} from '../domain/ledger';
export type { NetFiguresFailure, NetFiguresInput, NetRevenueAnswer, SellerNetEarningsAnswer };
export type {
  FinanceNet,
  MonthlyTargetAnswer,
  OrderStatusAnswer,
  OrdersByStateAnswer,
  ShoppingFunnelAnswer,
};
export type { FunnelStep, ShoppingFunnel } from '../domain/engagement';
export type { CalendarMonth, MonthEndForecast, MonthForecast } from '../domain/month-forecast';
export { MIN_FORECAST_DAYS } from '../domain/month-forecast';
export type { OrdersByState, StateShare } from '../domain/orders-by-state';
export type { OrderStatusCounts, SameDayShare, TakeRate } from '../domain/admin-health';
export type { InstantWindow } from '../domain/period';

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

  /**
   * The seller orders paid in the period, by where they stand now (one bucket each), and the
   * same-day share (paid with the `same_day` method ÷ paid; `not-enough-data` below 5 paid,
   * `not-available` while a paid one has no method recorded yet). Counts only: key
   * `ordering.order.view`, platform admin only.
   */
  marketplaceOrderStatus(
    context: CallContext,
    input: KpiPeriodInput,
  ): Promise<Result<OrderStatusAnswer, KpiFailure>>;

  /**
   * The seller orders paid in the period by the state they were delivered to (a pickup counts in
   * the store's state), with `unknown` for those with no state recorded and `other` beyond the
   * eight biggest; `not-enough-data` below five paid orders. Counts only: key
   * `ordering.order.view`, platform admin only.
   */
  marketplaceOrdersByState(
    context: CallContext,
    input: KpiPeriodInput,
  ): Promise<Result<OrdersByStateAnswer, KpiFailure>>;

  /**
   * The current calendar month of the Market against its monthly revenue target: GMV with tax to
   * date, the whole month before, the month-end forecast (an estimate; `not-enough-data` on the
   * first three days) and the pace. Not tied to the dashboard period. Keys
   * `commission-payouts.settlement.view` and `settings.monthly-revenue-target.view`, platform
   * admin only.
   */
  marketplaceMonthlyTarget(
    context: CallContext,
  ): Promise<Result<MonthlyTargetAnswer, AccessDenied>>;

  /**
   * The shopping funnel of the period against the period before (dashboards v2, phase 2), from the
   * nightly daily counts: signed-in customers with personalization on who viewed a product, added
   * to the cart, placed an order and paid, each within the step before, summed over the days
   * (customer-days). `not-enough-data` below 20 viewers; a step under five is hidden. Counts only:
   * key `ordering.order.view`, platform admin only.
   */
  marketplaceShoppingFunnel(
    context: CallContext,
    input: KpiPeriodInput,
  ): Promise<Result<ShoppingFunnelAnswer, KpiFailure>>;

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

  /**
   * Mondapac's net revenue of a range of Market days, without GST, with the "matching ledger"
   * readiness (FE-066): `netRevenue` is null until it is ready, a component with no source is
   * `not-available`, never 0, and `total` has an amount only when every component has one
   * (`partial` lists the missing ones instead). Key `commission-payouts.settlement.view`, platform admin only.
   * The range follows the custom range rules (`parsePeriodQuery`).
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
