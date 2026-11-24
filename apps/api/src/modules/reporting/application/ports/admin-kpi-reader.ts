import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { DayTotals } from '../../domain/admin-kpi';
import type { OrderStatusRead } from '../../domain/admin-health';
import type { StateTallies } from '../../domain/orders-by-state';
import type { DayRange } from '../../domain/period';

/**
 * The marketplace-wide daily numbers (table `daily_seller_sales`, every seller summed), for the
 * admin KPIs. Read-only: no unit is opened (ADR-0025). Scoped to the Market.
 */
export interface AdminKpiReader {
  /**
   * One row per day of `range` that has a fact, in `currency` only (the Market's), oldest first.
   * A day with no fact has no row.
   */
  dailyTotals(market: MarketContext, currency: string, range: DayRange): Promise<DailyTotals>;

  /**
   * The seller orders PAID on a day of `range` (`seller_orders` by `paid_day`), in `currency` only,
   * tallied by where they stand now, with those that have a succeeded refund (`refunds`, this
   * module's own table) set apart, and the paid ones by delivery method (same-day, unknown).
   * Counts only.
   */
  orderStatusTallies(
    market: MarketContext,
    currency: string,
    range: DayRange,
  ): Promise<OrderStatusRead>;

  /**
   * The seller orders PAID on a day of `range` (`seller_orders` by `paid_day`), in `currency` only,
   * counted per recorded `delivery_state`. Counts only; no postcode or address is ever read.
   */
  ordersByState(market: MarketContext, currency: string, range: DayRange): Promise<StateTallies>;

  /** How many sellers had at least one paid seller order in `range`, in `currency` only. */
  sellersWithOrders(market: MarketContext, currency: string, range: DayRange): Promise<number>;

  /**
   * The sellers with the most goods sold (GMV) in `range`, biggest first (ties by seller id), at
   * most `limit`, in `currency` only. A seller with no sale in the range is not listed.
   */
  topSellers(
    market: MarketContext,
    currency: string,
    range: DayRange,
    limit: number,
  ): Promise<SellerTotals[]>;

  /**
   * The categories with the most goods sold (`daily_category_sales`, every seller summed) in
   * `range`, biggest first (ties by category id), at most `limit`, in `currency` only.
   */
  topCategories(
    market: MarketContext,
    currency: string,
    range: DayRange,
    limit: number,
  ): Promise<CategoryTotals[]>;
}

/** One seller's summed numbers over a range (the top-sellers read). Refund goods are NEGATIVE. */
export interface SellerTotals {
  readonly sellerId: string;
  readonly ordersPaid: number;
  readonly goodsAmount: bigint;
  readonly ordersShipped: number;
  readonly ordersShippedOnTime: number;
  readonly refundGoodsAmount: bigint;
}

/** One category's summed sales over a range. Refund amounts are NEGATIVE; `categoryId` may be the nil UUID (goods whose category could not be read). */
export interface CategoryTotals {
  readonly categoryId: string;
  readonly orders: number;
  readonly salesAmount: bigint;
  readonly refundAmount: bigint;
}

export interface DailyTotals {
  readonly days: DayTotals[];
  /** When the newest row of the range was rebuilt; null with no row. The cards say "updated N min ago". */
  readonly refreshedAt: Temporal.Instant | null;
}

export const ADMIN_KPI_READER = Symbol('reporting.AdminKpiReader');
