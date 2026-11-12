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
  /**
   * Marks the run towards `stamp` done; a no-op when the row no longer targets `stamp` (a
   * {@link request} came in during the run, so it must run again).
   */
  finish(market: MarketContext, stamp: string, now: Temporal.Instant): Promise<void>;
  /**
   * Asks for a full re-read at the next tick even though catalog's stamp did not move (package 3a:
   * a change catalog's stamp cannot see, such as a certificate issuer derecognised, or a scope too
   * large for one delivery). Clears the done and target stamps, so a run already under way does not
   * mark itself done and the next tick begins afresh. No row yet: nothing to do (never run).
   */
  request(market: MarketContext, now: Temporal.Instant): Promise<void>;
  fail(market: MarketContext, code: string, now: Temporal.Instant): Promise<void>;
}

/** What catalog says about the attributes the index keeps; null when it cannot say. */
export interface IndexStamp {
  current(context: CallContext): Promise<string | null>;
}

export const REINDEX_PROGRESS = Symbol('REINDEX_PROGRESS');
export const INDEX_STAMP = Symbol('INDEX_STAMP');
