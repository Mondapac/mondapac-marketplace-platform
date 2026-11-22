import type { MarketContext } from '@mondapac/shared-kernel';
import type { SellerDay, SellerDayRollup } from '../../domain/rollup';

/**
 * The daily rollups (tables `daily_seller_sales`, `daily_category_sales`). Inside the caller's
 * unit, scoped to its Market.
 */
export interface RollupStore {
  /**
   * Makes the rows of one seller day exactly `rollup`: rows it holds are written, rows of that
   * day and seller it does not hold are removed.
   */
  replaceSellerDay(market: MarketContext, key: SellerDay, rollup: SellerDayRollup): Promise<void>;
}

export const ROLLUP_STORE = Symbol('reporting.RollupStore');
