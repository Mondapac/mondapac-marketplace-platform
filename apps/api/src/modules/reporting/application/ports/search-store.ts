import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { MarketDay } from '../../domain/facts';
import type { DayRange } from '../../domain/period';
import type { ZeroResultSearchDay } from '../../domain/zero-result-searches';

/**
 * `reporting.search_snapshot_days` and `reporting.daily_zero_result_searches` (dashboards v2, phase
 * 2): a day row and its query rows, written once together and never changed (the application role
 * may only SELECT and INSERT). Runs in the caller's unit.
 */
export interface SearchStore {
  /** The days of `range` that already have a day row. */
  recordedDays(market: MarketContext, range: DayRange): Promise<Set<MarketDay>>;
  /**
   * Writes a day's row and its query rows unless the day has a row; answers whether this call wrote
   * it. An existing day is never changed.
   */
  insertDay(
    market: MarketContext,
    day: MarketDay,
    rows: readonly Omit<ZeroResultSearchDay, 'day'>[],
    recordedAt: Temporal.Instant,
  ): Promise<boolean>;
  /** The query rows of `range`. */
  rows(market: MarketContext, range: DayRange): Promise<ZeroResultSearchDay[]>;
}

export const SEARCH_STORE = Symbol('reporting.SearchStore');
