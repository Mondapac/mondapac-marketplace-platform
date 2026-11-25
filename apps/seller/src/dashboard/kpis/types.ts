// The answer of GET reporting/seller/kpis (apps/api reporting, seller-kpis.dto.ts). Money is a
// decimal string of minor units; rates are basis points.

export const PERIODS = ['today', '7d', '30d', 'month'] as const;
export type Period = (typeof PERIODS)[number];
export const DEFAULT_PERIOD: Period = '30d';

export const isPeriod = (value: unknown): value is Period =>
  typeof value === 'string' && (PERIODS as readonly string[]).includes(value);

/** What the figures cover: a preset, or a range of the seller's own choice. */
export type ShownPeriod = Period | 'custom';

export interface KpiTotals {
  readonly salesInclTax: string;
  readonly salesExclTax: string;
  readonly orders: number;
  readonly units: number;
  readonly averageOrderValue: string | null;
  readonly refundedInclTax: string;
  readonly refunds: number;
  readonly refundRateBps: number | null;
  readonly ordersCancelled: number;
  readonly ordersShipped: number;
  readonly shippedOnTimeBps: number | null;
}

export interface KpiDay {
  readonly day: string;
  readonly salesInclTax: string;
  readonly orders: number;
  readonly refundedInclTax: string;
}

export interface KpiCategory {
  readonly categoryId: string;
  readonly netSalesInclTax: string;
  readonly orders: number;
  readonly units: number;
}

export interface SellerKpis {
  readonly period: {
    readonly id: ShownPeriod;
    readonly current: { readonly from: string; readonly to: string };
    readonly previous: { readonly from: string; readonly to: string };
    readonly days: number;
  };
  readonly timezone: string;
  readonly currency: string;
  readonly current: KpiTotals;
  readonly previous: KpiTotals;
  readonly series: readonly KpiDay[];
  readonly previousSeries: readonly KpiDay[];
  readonly topCategories: readonly KpiCategory[];
  readonly refreshedAt: string | null;
  /**
   * The current calendar month against the seller's own goal, whatever the period (dashboards v2,
   * phase 2). Null when the viewer may not read it; `error` when it failed. Optional so an answer
   * of an older API reads as left out.
   */
  readonly sellerGoal?: SellerGoalSection | null;
}

export type MonthForecast =
  | { readonly status: 'estimate'; readonly amount: string }
  | {
      readonly status: 'not-enough-data';
      readonly daysElapsed: number;
      readonly minimumDays: number;
    };

/** The month to date against the goal; money is minor units as a string in `currency`. */
export interface SellerGoalFigures {
  /** `YYYY-MM` of the Market's zone. */
  readonly month: string;
  readonly lastMonth: string;
  readonly timezone: string;
  readonly currency: string;
  readonly daysInMonth: number;
  readonly dayOfMonth: number;
  /** Days still to sell in, today included. */
  readonly daysLeft: number;
  readonly monthToDate: string;
  readonly lastMonthTotal: string;
  readonly forecast: MonthForecast;
  /** The goal; null while none is set. */
  readonly target: string | null;
  readonly progressBp: number | null;
  readonly paceBp: number | null;
  readonly toGo: string | null;
  readonly perDayToGo: string | null;
  /** The month's goal version for the edit; 0 while none is set. */
  readonly version: number;
}

export type SellerGoalSection =
  { readonly status: 'ok'; readonly goal: SellerGoalFigures } | { readonly status: 'error' };

/** PUT: the session's own seller only; this month or one of the next 12. */
export const SELLER_GOAL_PATH = 'reporting/seller/monthly-goal';
/** The seller key that sets the goal (the Seller Owner holds it). */
export const SELLER_GOAL_MANAGE_PERMISSION = 'reporting.seller-goal.manage';

/** The answer of the goal PUT. */
export interface SellerGoal {
  readonly month: string;
  readonly amount: string;
  readonly currency: string;
  readonly version: number;
  readonly updatedAt: string;
}

export const KPIS_PATH = 'reporting/seller/kpis';

/** The answer of GET reporting/seller/net-earnings: minor units as a string, null until `ready`. */
export interface SellerNetEarnings {
  readonly range: { readonly from: string; readonly to: string };
  readonly timezone: string;
  readonly currency: string;
  /** False until a week of matching ledger exists (FE-066): no figure is then sent. */
  readonly ready: boolean;
  readonly netEarnings: string | null;
  readonly refreshedAt: string | null;
}

export const NET_EARNINGS_PATH = 'reporting/seller/net-earnings';
