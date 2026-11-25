// What `GET dashboard/admin/kpis` answers (apps/api AdminKpisBody). Money is minor units as a
// string with its currency; rates are basis points; a section the session has no key for is null.

export const KPI_PERIODS = ['today', '7d', '30d', 'month'] as const;
export type KpiPeriod = (typeof KPI_PERIODS)[number];
/** A preset, or `custom` (a from/to range in the address). */
export type KpiPeriodId = KpiPeriod | 'custom';
export const DEFAULT_KPI_PERIOD: KpiPeriod = '7d';

export const isKpiPeriod = (value: unknown): value is KpiPeriod =>
  typeof value === 'string' && (KPI_PERIODS as readonly string[]).includes(value);

/** The keys that open the two sections; the card is asked for when the session holds either. */
export const KPI_ORDERS_PERMISSION = 'ordering.order.view';
/** The key that opens the sellers pages the top-sellers card links to. */
export const KPI_SELLERS_PERMISSION = 'sellers.seller.view';
export const KPI_MONEY_PERMISSION = 'commission-payouts.settlement.view';
/** With the money key, opens the month against the Market's monthly revenue target. */
export const KPI_TARGET_PERMISSION = 'settings.monthly-revenue-target.view';
/** Opens the Sales target settings page the target card's Edit link goes to. */
export const KPI_TARGET_MANAGE_PERMISSION = 'settings.monthly-revenue-target.manage';
/** The key of the zero-result searches (the catalogue team's view). */
export const KPI_CATALOG_PERMISSION = 'catalog.product.view';
/** With the money key, opens the discount cost (spend is for promotion managers). */
export const KPI_PROMOTIONS_PERMISSION = 'promotions.promotion.manage';
/** The key of the reviews card (reviews settings; platform administrator only). */
export const KPI_REVIEWS_PERMISSION = 'reviews.settings.view';
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
  /** The monthly target card: the money key and the target view key (dashboards v2, phase 2). */
  readonly target: boolean;
  /** The zero-result searches card: `catalog.product.view`. */
  readonly searches: boolean;
  /** The discount cost card: the money key and `promotions.promotion.manage`. */
  readonly discounts: boolean;
  /** The reviews card of the last 30 days: `reviews.settings.view`. */
  readonly reviews: boolean;
}

export const allowedOf = (permissionKeys: readonly string[]): KpiAllowed => {
  const keys = new Set(permissionKeys);
  return {
    money: keys.has(KPI_MONEY_PERMISSION),
    orders: keys.has(KPI_ORDERS_PERMISSION),
    health: KPI_HEALTH_PERMISSIONS.some((key) => keys.has(key)),
    target: keys.has(KPI_MONEY_PERMISSION) && keys.has(KPI_TARGET_PERMISSION),
    searches: keys.has(KPI_CATALOG_PERMISSION),
    discounts: keys.has(KPI_MONEY_PERMISSION) && keys.has(KPI_PROMOTIONS_PERMISSION),
    reviews: keys.has(KPI_REVIEWS_PERMISSION),
  };
};

/** True when the session may be shown any of the KPI cards (the page then reads them). */
export const wantsKpis = (allowed: KpiAllowed): boolean =>
  allowed.money || allowed.orders || allowed.health || allowed.searches || allowed.reviews;

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

// Dashboards v2, phase 2. Each section is null without its key(s) and `error` when its read failed;
// `not-enough-data` carries no figure, never a zero.

export interface StateShare {
  /** Region code of the delivery address (a pickup counts in the store's state). */
  readonly state: string;
  readonly orders: number;
  readonly shareBp: number;
}

export interface OtherShare {
  readonly orders: number;
  readonly shareBp: number;
}

export type OrdersByStateKpis =
  | {
      readonly status: 'available';
      readonly paid: number;
      /** Biggest first, at most eight. */
      readonly states: readonly StateShare[];
      readonly other: OtherShare | null;
      /** Paid orders with no state recorded yet; never folded into a state. */
      readonly unknown: OtherShare | null;
    }
  | { readonly status: 'not-enough-data'; readonly paid: number; readonly minimum: number };

export type MonthForecast =
  | { readonly status: 'estimate'; readonly amount: string }
  | {
      readonly status: 'not-enough-data';
      readonly daysElapsed: number;
      readonly minimumDays: number;
    };

/** The current calendar month against a target (the Market's) or a goal (the seller's). */
export interface MonthFigures {
  /** `YYYY-MM` of the Market's zone. */
  readonly month: string;
  readonly lastMonth: string;
  readonly timezone: string;
  /** ISO 4217; every amount is in it (minor units as a string). */
  readonly currency: string;
  readonly daysInMonth: number;
  readonly dayOfMonth: number;
  /** Days still to sell in, today included. */
  readonly daysLeft: number;
  readonly monthToDate: string;
  readonly lastMonthTotal: string;
  readonly forecast: MonthForecast;
  /** Null while none is set. */
  readonly target: string | null;
  readonly progressBp: number | null;
  readonly paceBp: number | null;
  readonly toGo: string | null;
  readonly perDayToGo: string | null;
}

export interface MarketTargetKpis extends MonthFigures {
  readonly refreshedAt: string | null;
}

export interface FunnelStepKpi {
  /** Customer-days; null when under five (hidden), never 0. */
  readonly count: number | null;
  /** Of the step before; null for the first step or when hidden. */
  readonly rateBp: number | null;
  readonly change: KpiDelta;
  readonly rateChange: KpiDelta;
}

export interface ShoppingFunnelKpis {
  readonly status: 'available' | 'not-enough-data';
  readonly minimum?: number;
  readonly viewed?: FunnelStepKpi;
  readonly carted?: FunnelStepKpi;
  readonly checkedOut?: FunnelStepKpi;
  readonly paid?: FunnelStepKpi;
  readonly recordedDays: number;
  readonly periodDays: number;
}

export interface ZeroResultQuery {
  /** The folded text as searched. Data, never markup: render it as a plain text node only. */
  readonly query: string;
  readonly searches: number;
  readonly searcherDays: number;
  readonly days: number;
}

export interface ZeroResultSearchesKpis {
  readonly status: 'available' | 'not-enough-data';
  readonly minimumSearchers?: number;
  /** At most ten, most searches first. */
  readonly queries?: readonly ZeroResultQuery[];
  readonly recordedDays: number;
  readonly periodDays: number;
}

export interface DiscountKindCost {
  readonly kind: 'promotion' | 'first-order' | 'free-shipping';
  /** Null: 1 to 4 uses, every figure of the kind held back ("fewer than 5"), never 0. */
  readonly uses: number | null;
  readonly amount: KpiMoney | null;
  readonly platformShare: KpiMoney | null;
  readonly shareBp: number | null;
}

export interface DiscountCostKpis {
  readonly status: 'available' | 'not-enough-data';
  readonly orders: number;
  readonly minimum?: number;
  readonly amount?: KpiMoney;
  readonly platformShare?: KpiMoney;
  readonly sellerShare?: KpiMoney;
  readonly platformShareBp?: number | null;
  readonly change?: KpiDelta;
  readonly previousAmount?: KpiMoney;
  readonly byKind?: readonly DiscountKindCost[];
  /** Null when 1 to 4 orders gave a discount back (held back). */
  readonly released?: { readonly orders: number; readonly amount: KpiMoney } | null;
}

export interface AbandonedCartsKpis {
  readonly status: 'available' | 'not-enough-data';
  readonly minimum?: number;
  /** A level on `asOfDay` (untouched 24h+), not a sum over the period. */
  readonly carts?: number;
  /** Approximate (prices when the items were added); null with mixed currencies. */
  readonly approximateValue?: KpiMoney | null;
  readonly asOfDay?: string;
  readonly change?: KpiDelta;
  readonly recordedDays: number;
  readonly periodDays: number;
}

export interface ReviewsKpis {
  /** `off`: reviews are switched off in the Market (not an error). */
  readonly status: 'available' | 'not-enough-data' | 'off';
  readonly minimum?: number;
  readonly reviews?: number;
  readonly reviewsChange?: KpiDelta;
  /** Hundredths of a star: 433 is 4.33. */
  readonly averageTimes100?: number;
  readonly averageChangeTimes100?: KpiDelta;
  /** Reviews of 1, 2, 3, 4 and 5 stars. */
  readonly histogram?: readonly number[];
  readonly lowStarShareBp?: number;
  readonly lowStarShareChange?: KpiDelta;
}

/** The 30 days a reviews section covers (Market days, both ends included). */
export interface ReviewsWindow {
  readonly current: { readonly from: string; readonly to: string };
  readonly previous: { readonly from: string; readonly to: string };
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
  // Phase 2 sections: optional so an answer of an older API reads as "left out".
  readonly ordersByState?: KpiSection<OrdersByStateKpis> | null;
  readonly marketTarget?: KpiSection<MarketTargetKpis> | null;
  readonly shoppingFunnel?: KpiSection<ShoppingFunnelKpis> | null;
  readonly zeroResultSearches?: KpiSection<ZeroResultSearchesKpis> | null;
  readonly discountCost?: KpiSection<DiscountCostKpis> | null;
  readonly abandonedCarts?: KpiSection<AbandonedCartsKpis> | null;
  /** Always the last 30 Market days, whatever period the page shows. */
  readonly reviews?: (KpiSection<ReviewsKpis> & { readonly period?: ReviewsWindow }) | null;
  readonly topSellers: KpiSection<TopSellersKpis> | null;
  readonly topCategories: KpiSection<TopCategoriesKpis> | null;
  /** Null when the viewer holds none of the keys of its numbers. */
  readonly health: MarketHealth | null;
}

/** The KPI read as the page passes it: null when the session holds no key of it, or it is refused. */
export type KpiAnswer =
  { readonly kind: 'ok'; readonly value: AdminKpis } | { readonly kind: 'error' };
/** `invalid`: the range was refused (a 400 `validation.failed`); the fields say which. */
export type KpiResult =
  | KpiAnswer
  | {
      readonly kind: 'invalid';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };
export type AdminKpiSource = KpiResult | null | Promise<KpiResult | null>;
