import type { Id, MarketContext, Money, Temporal } from '@mondapac/shared-kernel';
import type { CalendarMonth } from '../../domain/month-forecast';

/** A seller's goal for one month, as stored. */
export interface SellerMonthlyGoal {
  readonly month: CalendarMonth;
  readonly goal: Money;
  /** 1 when first set, +1 for each change. */
  readonly version: number;
  readonly updatedAt: Temporal.Instant;
}

export interface SellerGoalChange {
  readonly sellerId: Id<'Seller'>;
  readonly month: CalendarMonth;
  readonly goal: Money;
  /** The version after the change: 1 inserts, any other updates the row at `version - 1`. */
  readonly version: number;
  readonly changedAt: Temporal.Instant;
  readonly changedBy: Id<'Account'>;
}

/**
 * `reporting.seller_monthly_goals`, inside the caller's unit. Every statement is limited to the
 * Market and the one seller named.
 */
export interface SellerGoalStore {
  find(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    month: CalendarMonth,
  ): Promise<SellerMonthlyGoal | null>;

  /**
   * Writes the goal when the stored version is still `change.version - 1` (0: no row). False when
   * another session changed it first (nothing written; the unit stays usable).
   */
  save(market: MarketContext, change: SellerGoalChange): Promise<boolean>;
}

export const SELLER_GOAL_STORE = Symbol('reporting.SellerGoalStore');
