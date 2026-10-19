import type { MarketContext, Temporal } from '@mondapac/shared-kernel';

/** A Market's assistant spend for one day of its calendar, and the month it is in. */
export interface SpendTotals {
  readonly todayMicroUsd: number;
  readonly monthMicroUsd: number;
  readonly conversationsToday: number;
  /** The last time a cap switched the assistant off, and which cap; null if never. */
  readonly lastAutoOff: { readonly at: Temporal.Instant; readonly cap: 'daily' | 'monthly' } | null;
}

/**
 * `assistant.spend_days`: one row per Market and day (the Market's own calendar), counted up by
 * every model call, so every API instance sees the same totals.
 */
export interface SpendRepository {
  totals(market: MarketContext, day: Temporal.PlainDate): Promise<SpendTotals>;
  add(
    market: MarketContext,
    day: Temporal.PlainDate,
    spend: {
      readonly microUsd: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly conversations: number;
    },
  ): Promise<void>;
  /** Records that a cap switched the assistant off; false when this day already has a record. */
  markAutoOff(
    market: MarketContext,
    day: Temporal.PlainDate,
    cap: 'daily' | 'monthly',
    at: Temporal.Instant,
  ): Promise<boolean>;
}

export const SPEND_REPOSITORY = Symbol('SPEND_REPOSITORY');
