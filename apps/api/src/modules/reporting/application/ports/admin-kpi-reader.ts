import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { DayTotals } from '../../domain/admin-kpi';
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
   * The sellers with the most goods sold (GMV) in `range`, biggest first (ties by seller id), at
   * most `limit`, in `currency` only. A seller with no sale in the range is not listed.
   */
  topSellers(
    market: MarketContext,
    currency: string,
    range: DayRange,
    limit: number,
  ): Promise<SellerTotals[]>;
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

export interface DailyTotals {
  readonly days: DayTotals[];
  /** When the newest row of the range was rebuilt; null with no row. The cards say "updated N min ago". */
  readonly refreshedAt: Temporal.Instant | null;
}

export const ADMIN_KPI_READER = Symbol('reporting.AdminKpiReader');
