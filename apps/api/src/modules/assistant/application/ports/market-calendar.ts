import type { MarketContext, Temporal } from '@mondapac/shared-kernel';

/** The Market's own day, for its daily and monthly spend caps (ADR-0005: the owner's zone). */
export interface MarketCalendar {
  dayOf(market: MarketContext, at: Temporal.Instant): Temporal.PlainDate;
  /** The first instant of the Market's day (its zone, not UTC). */
  startOf(market: MarketContext, day: Temporal.PlainDate): Temporal.Instant;
}

export const MARKET_CALENDAR = Symbol('ASSISTANT_MARKET_CALENDAR');
