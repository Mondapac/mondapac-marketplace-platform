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
/** The keys of the numbers of the supply and health card; any one of them shows the card. */
export const KPI_HEALTH_PERMISSIONS = [
  'catalog.product.view',
  'sellers.seller.view',
  'certification.seller-certificate.view',
  KPI_MONEY_PERMISSION,
  'commission-payouts.dispute.view',
] as const;

/** A group of figures is asked for on the key of its section (the API leaves it out otherwise). */
export interface KpiAllowed {
  readonly money: boolean;
  readonly orders: boolean;
  readonly health: boolean;
}

export const allowedOf = (permissionKeys: readonly string[]): KpiAllowed => {
  const keys = new Set(permissionKeys);
  return {
    money: keys.has(KPI_MONEY_PERMISSION),
    orders: keys.has(KPI_ORDERS_PERMISSION),
    health: KPI_HEALTH_PERMISSIONS.some((key) => keys.has(key)),
  };
};

/** True when the session may be shown any of the KPI cards (the page then reads them). */
export const wantsKpis = (allowed: KpiAllowed): boolean =>
  allowed.money || allowed.orders || allowed.health;

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
  /** Sellers with at least one paid order in the period; null when it could not be read. */
  readonly sellersWithOrders: number | null;
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
  /** Net revenue and take rate; null when only this read failed (GMV still shows). */
  readonly net: FinanceNet | null;
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

/** A count of the health card: its number, or `error`. */
export type HealthCount =
  { readonly status: 'ok'; readonly count: number } | { readonly status: 'error' };

export type NotRecorded = {
  readonly status: 'not-available';
  readonly reason: 'not-reported' | 'not-recorded';
};

export type KpiLedgerReason =
  | 'ready'
  | 'backfill-not-finished'
  | 'backfill-refused-rows'
  | 'days-not-matching'
  | 'insufficient-activity';

export interface NetComponent {
  readonly status: 'available' | 'not-available';
  readonly amount?: KpiMoney;
  readonly reason?: 'not-reported' | 'not-recorded';
}

/** The total of net revenue: `partial` carries no amount, only what is missing. */
export type NetTotal =
  | { readonly status: 'complete'; readonly amount: KpiMoney }
  | { readonly status: 'partial'; readonly missing: readonly string[] };

export interface NetRevenue {
  readonly currency: string;
  readonly commissionCharged: KpiMoney;
  readonly commissionRefunded: KpiMoney;
  readonly components: Readonly<Record<string, NetComponent>>;
  readonly total: NetTotal;
}

export interface TakeRate {
  readonly status: 'complete' | 'partial' | 'no-sales';
  readonly rateBp?: number;
  readonly basis?: readonly string[];
  readonly missing?: readonly string[];
}

export interface FinanceNet {
  readonly readiness: { readonly ready: boolean; readonly reason: KpiLedgerReason };
  /** Null until the ledger is ready. */
  readonly current: NetRevenue | null;
  readonly previous: NetRevenue | null;
  readonly takeRate: { readonly current: TakeRate | null; readonly previous: TakeRate | null };
  readonly deltas: Readonly<Record<string, KpiDelta>>;
}

export type SameDayShare =
  | {
      readonly status: 'available';
      readonly sameDay: number;
      readonly paid: number;
      readonly rateBp: number;
    }
  | { readonly status: 'not-enough-data'; readonly paid: number; readonly minimum: number }
  | {
      readonly status: 'not-available';
      readonly reason: 'method-unknown';
      readonly unknownMethod: number;
    };

export interface OrdersByStatusKpis {
  readonly paid: number;
  readonly toShip: number;
  readonly shipped: number;
  readonly delivered: number;
  readonly cancelled: number;
  readonly refunded: number;
  readonly cancelledRateBp: number | null;
  readonly refundedRateBp: number | null;
  readonly sameDayShare: SameDayShare;
}

export interface ListingsHealth {
  readonly status: 'ok' | 'error';
  readonly active?: number;
  readonly outOfStock?: number;
  readonly outOfStockRateBp?: number | null;
}

export interface CertificatesExpiring {
  readonly status: 'ok' | 'error';
  readonly count?: number;
  readonly withinDays?: number;
}

export interface PayoutsOnHold {
  readonly status: 'ok' | 'error';
  readonly count?: number;
  /** The money the holds keep is not recorded per hold yet: never shown as 0. */
  readonly amount?: NotRecorded;
}

export interface DisputeRate {
  readonly status: 'ok' | 'error';
  readonly disputes?: number;
  readonly paidSellerOrders?: number;
  readonly rateBp?: number | null;
}

export interface MarketHealth {
  readonly uncertifiedListings: HealthCount | null;
  readonly sellersAtRisk: HealthCount | null;
  readonly listings: ListingsHealth | null;
  readonly certificatesExpiring: CertificatesExpiring | null;
  readonly payoutsOnHold: PayoutsOnHold | null;
  readonly disputeRate: DisputeRate | null;
}

export interface AdminKpis {
  readonly generatedAt: string;
  readonly periodId: KpiPeriod | 'custom';
  readonly period: {
    readonly id: KpiPeriod | 'custom';
    readonly current: { readonly from: string; readonly to: string };
    readonly previous: { readonly from: string; readonly to: string };
  } | null;
  readonly operations: KpiSection<OperationsKpis> | null;
  readonly finance: KpiSection<FinanceKpis> | null;
  readonly ordersByStatus: KpiSection<OrdersByStatusKpis> | null;
  readonly topSellers: KpiSection<TopSellersKpis> | null;
  readonly topCategories: KpiSection<TopCategoriesKpis> | null;
  /** Null when the viewer holds none of the keys of its numbers. */
  readonly health: MarketHealth | null;
}

/** The KPI read as the page passes it: null when the session holds no key of it, or it is refused. */
export type KpiResult =
  { readonly kind: 'ok'; readonly value: AdminKpis } | { readonly kind: 'error' };
export type AdminKpiSource = KpiResult | null | Promise<KpiResult | null>;
