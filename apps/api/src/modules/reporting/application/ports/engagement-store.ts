import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { EngagementDay } from '../../domain/engagement';
import type { MarketDay } from '../../domain/facts';
import type { DayRange } from '../../domain/period';

/**
 * `reporting.daily_engagement` (dashboards v2, phase 2): one row per Market day, written once and
 * never changed (the application role may only SELECT and INSERT). Runs in the caller's unit.
 */
export interface EngagementStore {
  /** The days of `range` that already have a row. */
  recordedDays(market: MarketContext, range: DayRange): Promise<Set<MarketDay>>;
  /**
   * Writes a day's row unless it has one; answers whether this call wrote it. An existing row is
   * never changed (a later run, or one overlapping this one, keeps the first snapshot).
   */
  insertDay(
    market: MarketContext,
    day: EngagementDay,
    recordedAt: Temporal.Instant,
  ): Promise<boolean>;
  /** The rows of `range`, oldest first. */
  days(market: MarketContext, range: DayRange): Promise<EngagementDay[]>;
}

export const ENGAGEMENT_STORE = Symbol('reporting.EngagementStore');
