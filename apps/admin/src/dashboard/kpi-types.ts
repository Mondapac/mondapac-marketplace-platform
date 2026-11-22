// What `GET dashboard/admin/kpis` answers (apps/api AdminKpisBody). Money is minor units as a
// string with its currency; rates are basis points; a section the session has no key for is null.

export const KPI_PERIODS = ['today', '7d', '30d', 'month'] as const;
export type KpiPeriod = (typeof KPI_PERIODS)[number];
export const DEFAULT_KPI_PERIOD: KpiPeriod = '7d';

export const isKpiPeriod = (value: unknown): value is KpiPeriod =>
  typeof value === 'string' && (KPI_PERIODS as readonly string[]).includes(value);

/** The keys that open the two sections; the card is asked for when the session holds either. */
export const KPI_ORDERS_PERMISSION = 'ordering.order.view';
/** The key that opens the sellers pages the top-sellers card links to. */
export const KPI_SELLERS_PERMISSION = 'sellers.seller.view';
export const KPI_MONEY_PERMISSION = 'commission-payouts.settlement.view';

export interface KpiDelta {
  /** Basis points: a percentage change, or for a rate the difference in points. */
  readonly value: number;
  readonly direction: 'up' | 'down' | 'flat';
  readonly state: 'ok' | 'na';
}

export interface KpiMoney {
  readonly amountMinor: string;
  readonly currency: string;
}

export interface OperationsValues {
  readonly ordersPaid: number;
  readonly ordersCancelled: number;
  readonly cancelRateBp: number | null;
  readonly ordersShipped: number;
  readonly onTimeRateBp: number | null;
  readonly ordersDelivered: number;
  readonly refunds: number;
}

export interface OperationsPoint {
  readonly day: string;
  readonly ordersPaid: number;
  readonly ordersCancelled: number;
  readonly refunds: number;
}

export interface FinanceValues {
  readonly gmvWithTax: KpiMoney;
  readonly gmvWithoutTax: KpiMoney;
  readonly refundedWithTax: KpiMoney;
  readonly refundRateBp: number | null;
  readonly netSalesWithTax: KpiMoney;
  readonly averageOrderWithTax: KpiMoney | null;
}

export interface FinancePoint {
  readonly day: string;
  readonly gmvWithTax: string;
  readonly gmvWithoutTax: string;
  readonly refundedWithTax: string;
}

export type KpiSection<K> =
  | { readonly status: 'ok'; readonly refreshedAt?: string | null; readonly kpis: K }
  | { readonly status: 'error' };

export interface OperationsKpis {
  readonly current: OperationsValues;
  readonly previous: OperationsValues;
  readonly deltas: Readonly<Record<keyof OperationsValues, KpiDelta>>;
  readonly series: readonly OperationsPoint[];
  readonly previousSeries: readonly OperationsPoint[];
}

export interface FinanceKpis {
  readonly currency: string;
  readonly current: FinanceValues;
  readonly previous: FinanceValues;
  readonly deltas: Readonly<Record<keyof FinanceValues, KpiDelta>>;
  readonly series: readonly FinancePoint[];
  readonly previousSeries: readonly FinancePoint[];
}

export interface TopSellerRow {
  readonly sellerId: string;
  /** The public store name; null when it could not be read. */
  readonly storeName: string | null;
  readonly gmvWithTax: KpiMoney;
  readonly ordersPaid: number;
  readonly onTimeRateBp: number | null;
  readonly refundRateBp: number | null;
}

export interface TopSellersKpis {
  readonly rows: readonly TopSellerRow[];
}

export interface TopCategoryRow {
  readonly categoryId: string;
  /** The category's name; null when it is gone or its goods had no readable category. */
  readonly name: string | null;
  readonly salesWithTax: KpiMoney;
  readonly orders: number;
}

export interface TopCategoriesKpis {
  readonly rows: readonly TopCategoryRow[];
}

export interface AdminKpis {
  readonly generatedAt: string;
  readonly periodId: KpiPeriod;
  readonly period: {
    readonly id: KpiPeriod;
    readonly current: { readonly from: string; readonly to: string };
    readonly previous: { readonly from: string; readonly to: string };
  } | null;
  readonly operations: KpiSection<OperationsKpis> | null;
  readonly finance: KpiSection<FinanceKpis> | null;
  /** Needs the money key, like `finance`; null leaves the card out. */
  readonly topSellers: KpiSection<TopSellersKpis> | null;
  /** Needs the money key, like `finance`; null leaves the card out. */
  readonly topCategories: KpiSection<TopCategoriesKpis> | null;
}

/** The KPI read as the page passes it: null when the session holds neither key. */
export type KpiResult =
  { readonly kind: 'ok'; readonly value: AdminKpis } | { readonly kind: 'error' };
export type AdminKpiSource = KpiResult | null | Promise<KpiResult | null>;
