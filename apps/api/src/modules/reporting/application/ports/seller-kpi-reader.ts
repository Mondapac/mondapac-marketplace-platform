import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { DayRange } from '../../domain/period';
import type { SellerKpiCategoryRow, SellerKpiDayRow } from '../../domain/seller-kpis';

export interface SellerKpiRead {
  readonly daily: readonly SellerKpiDayRow[];
  readonly categories: readonly SellerKpiCategoryRow[];
}

/**
 * The seller's rollup rows (tables `daily_seller_sales`, `daily_category_sales`), read inside the
 * caller's read-only unit. Every statement is limited to the Market, the one seller named and the
 * Market's currency: there is no read without a seller.
 */
export interface SellerKpiReader {
  /**
   * The daily rows of `sellerId` from `previous.from` through `current.to`, and its category rows
   * summed over `current`.
   */
  read(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    currency: string,
    current: DayRange,
    previous: DayRange,
  ): Promise<SellerKpiRead>;

  /** The daily rows of `sellerId` in `range`, oldest first; a day with no fact has no row. */
  daily(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    currency: string,
    range: DayRange,
  ): Promise<readonly SellerKpiDayRow[]>;
}

export const SELLER_KPI_READER = Symbol('reporting.SellerKpiReader');
