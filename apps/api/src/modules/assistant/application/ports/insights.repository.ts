import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { UnansweredCandidate } from '../../domain/insights';

export interface DayInsight {
  readonly day: Temporal.PlainDate;
  readonly conversations: number;
  readonly spendMicroUsd: number;
}

export interface FeedbackInsight {
  readonly up: number;
  readonly down: number;
  readonly reasons: {
    readonly wrong: number;
    readonly 'not-found': number;
    readonly other: number;
  };
}

/**
 * Read-only aggregates of the assistant for the admin insights. A range is `[from, to)` in
 * instants (the Market's own days, converted by the caller). Only the retained messages exist:
 * a conversation that keeps no text leaves nothing here but its spend day.
 */
export interface InsightsRepository {
  /** Conversations and spend per Market day, both days included; days without a row are omitted. */
  days(
    market: MarketContext,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ): Promise<readonly DayInsight[]>;
  /** Thumbs given on assistant messages written in the range. */
  feedback(
    market: MarketContext,
    from: Temporal.Instant,
    to: Temporal.Instant,
  ): Promise<FeedbackInsight>;
  /** Assistant messages in the range that carried the support card. */
  handoffs(market: MarketContext, from: Temporal.Instant, to: Temporal.Instant): Promise<number>;
  /**
   * The newest turns in the range that a buyer was not served well, with the buyer's masked
   * line (decrypted here). A conversation whose key is destroyed is skipped.
   */
  unanswered(
    market: MarketContext,
    from: Temporal.Instant,
    to: Temporal.Instant,
    limit: number,
  ): Promise<readonly UnansweredCandidate[]>;
}

export const INSIGHTS_REPOSITORY = Symbol('INSIGHTS_REPOSITORY');
