// The answer of GET reporting/seller/kpis (apps/api reporting, seller-kpis.dto.ts). Money is a
// decimal string of minor units; rates are basis points.

export const PERIODS = ['today', '7d', '30d', 'month'] as const;
export type Period = (typeof PERIODS)[number];
export const DEFAULT_PERIOD: Period = '30d';

export const isPeriod = (value: unknown): value is Period =>
  typeof value === 'string' && (PERIODS as readonly string[]).includes(value);

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
    readonly id: Period;
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
}

export const KPIS_PATH = 'reporting/seller/kpis';
