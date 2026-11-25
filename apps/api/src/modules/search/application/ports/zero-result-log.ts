import type { MarketContext, Temporal } from '@mondapac/shared-kernel';

/**
 * `search.zero_result_queries` (dashboards v2, phase 2): the folded texts of plain text searches
 * that found nothing, one row per text and UTC quarter hour. No person is named. Runs in the
 * caller's unit, scoped to the Market.
 */
export interface ZeroResultLog {
  /** Notes a text in a quarter hour; a second note of the same pair changes nothing. */
  note(market: MarketContext, key: string, bucketStart: Temporal.Instant): Promise<void>;
  /**
   * The distinct texts noted in `[from, to)`, those noted in the most quarter hours first (then by
   * text), at most `limit`. A text typed once (a typo, a name) is noted in one quarter hour; a
   * text many shoppers miss is noted in many, so the cap keeps those.
   */
  textsIn(
    market: MarketContext,
    window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant },
    limit: number,
  ): Promise<string[]>;
  /** Deletes every row of the Market before `before`; answers how many went. */
  purgeBefore(market: MarketContext, before: Temporal.Instant): Promise<number>;
}

export const ZERO_RESULT_LOG = Symbol('search.ZeroResultLog');
