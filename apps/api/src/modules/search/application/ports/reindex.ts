import type { CallContext, Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** The progress of the attribute reindex in one Market (one row per Market). */
export interface ReindexState {
  /** The catalog stamp the whole index was last rebuilt for; null before the first run. */
  readonly doneStamp: string | null;
  readonly targetStamp: string | null;
  readonly status: 'idle' | 'running' | 'failed';
  readonly offersDone: number;
  /** The last Offer id of the last page done: a run towards the same stamp resumes after it. */
  readonly cursorOfferId: Id<'Offer'> | null;
}

/** Where the reindex keeps its progress. Each call is one write in the caller's unit. */
export interface ReindexProgress {
  read(market: MarketContext): Promise<ReindexState | null>;
  begin(market: MarketContext, targetStamp: string, now: Temporal.Instant): Promise<void>;
  advance(
    market: MarketContext,
    offersDone: number,
    cursor: Id<'Offer'>,
    now: Temporal.Instant,
  ): Promise<void>;
  finish(market: MarketContext, stamp: string, now: Temporal.Instant): Promise<void>;
  fail(market: MarketContext, code: string, now: Temporal.Instant): Promise<void>;
}

/** What catalog says about the attributes the index keeps; null when it cannot say. */
export interface IndexStamp {
  current(context: CallContext): Promise<string | null>;
}

export const REINDEX_PROGRESS = Symbol('REINDEX_PROGRESS');
export const INDEX_STAMP = Symbol('INDEX_STAMP');
