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
 * The assistant's spend and conversation count per Market day (the Market's own calendar), shared
 * by every API instance. Since AI Gateway G7 the spend is the gateway's usage record of the buyer
 * chat (every call is settled there before the runtime answers), the conversation count is
 * `assistant.conversation_days`, and the auto-off record is the gateway's "cap reached" record.
 */
export interface SpendRepository {
  totals(market: MarketContext, day: Temporal.PlainDate): Promise<SpendTotals>;
  /**
   * Counts a turn: its new conversations. The spend fields are what the gateway settled for the
   * turn already; the production store does not count them a second time.
   */
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
