import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AbandonedCartsDay } from '../../domain/abandoned-carts';
import type { MarketDay } from '../../domain/facts';
import type { DayRange } from '../../domain/period';

/**
 * `reporting.daily_abandoned_carts` (dashboards v2, phase 2): one row per Market day, written once
 * and never changed (the application role may only SELECT and INSERT). Runs in the caller's unit.
 */
export interface AbandonedCartsStore {
  /** Whether the day already has a row. */
  hasDay(market: MarketContext, day: MarketDay): Promise<boolean>;
  /** Writes the day's row unless it has one; answers whether this call wrote it. */
  insertDay(
    market: MarketContext,
    day: AbandonedCartsDay,
    recordedAt: Temporal.Instant,
  ): Promise<boolean>;
  /** The rows of `range`, oldest first. */
  days(market: MarketContext, range: DayRange): Promise<AbandonedCartsDay[]>;
}

export const ABANDONED_CARTS_STORE = Symbol('reporting.AbandonedCartsStore');
