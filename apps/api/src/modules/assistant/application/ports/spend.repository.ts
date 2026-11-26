import type { CallContext, MarketContext, Temporal } from '@mondapac/shared-kernel';

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
  /**
   * Which of the chat's own gateway caps is full now (AI Gateway G4d2): `daily`, `monthly`, or
   * null. Computed against the gateway's caps, as the gateway refuses the next call. Never called
   * inside a UnitOfWork (it reads in units of its own); throws when it cannot be read.
   */
  capReached(context: CallContext): Promise<'daily' | 'monthly' | null>;
  /** Records that a cap switched the assistant off; false when this day already has a record. */
  markAutoOff(
    market: MarketContext,
    day: Temporal.PlainDate,
    cap: 'daily' | 'monthly',
    at: Temporal.Instant,
  ): Promise<boolean>;
}

export const SPEND_REPOSITORY = Symbol('SPEND_REPOSITORY');
