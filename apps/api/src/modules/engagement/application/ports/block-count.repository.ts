import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { BlockCountIncrement, BlockCountRow } from '../../domain/block-count';

/**
 * `engagement.block_counts`: the daily impression and click counts of storefront blocks, in the
 * caller's Market. Aggregate numbers only; runs inside the caller's unit of work.
 */
export interface BlockCountRepository {
  /**
   * Adds each increment to the row of its (page, placement) on `day`, creating the row on the
   * first event of the day. The increments are applied in the order given.
   */
  increment(
    market: MarketContext,
    day: Temporal.PlainDate,
    at: Temporal.Instant,
    increments: readonly BlockCountIncrement[],
  ): Promise<void>;

  /**
   * The Market's rows of one page from `from` to `to` (UTC days, both included), at most
   * `limit` of them, by placement then day. Read-only.
   */
  daily(
    market: MarketContext,
    pageId: Id<'StorefrontPage'>,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
    limit: number,
  ): Promise<BlockCountRow[]>;

  /** Deletes the Market's rows of days before `day`; answers how many went. */
  purgeBefore(market: MarketContext, day: Temporal.PlainDate): Promise<number>;
}

export const BLOCK_COUNT_REPOSITORY = Symbol('BLOCK_COUNT_REPOSITORY');
