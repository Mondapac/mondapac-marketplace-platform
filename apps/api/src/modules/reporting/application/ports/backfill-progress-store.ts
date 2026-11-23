import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { BackfillKind } from '../report-facts-sync';

/** Where the history backfill of one kind of fact stands in one Market. */
export interface BackfillProgress {
  readonly kind: BackfillKind;
  /**
   * The window's end, fixed when the backfill started; later facts come from the worker. The
   * `delivery` pass reads reporting's own rows instead and does not use it; on a Market whose
   * backfill started before that pass existed, its row is added later with its own `until`.
   */
  readonly until: Temporal.Instant;
  /** The id cursor of the last page written; null before the first. */
  readonly after: string | null;
  readonly pages: number;
  readonly failedFacts: number;
  readonly finishedAt: Temporal.Instant | null;
}

/** What one written page moves the progress to. */
export interface BackfillStep {
  readonly after: string | null;
  readonly pages: number;
  readonly failedFacts: number;
  readonly finished: boolean;
}

/**
 * The backfill's progress (table `reporting.backfill_progress`). Every method runs inside the
 * caller's unit and is scoped to its Market.
 */
export interface BackfillProgressStore {
  /**
   * The progress of every kind, in the order of `BACKFILL_KINDS`. A kind with none yet is started
   * with `until`, all in one unit so every kind shares one window end (a concurrent start keeps the
   * first). Once every kind has a row it only reads.
   */
  startAll(market: MarketContext, until: Temporal.Instant): Promise<readonly BackfillProgress[]>;
  /**
   * Moves the progress on from `from` to `to`, only while it is still at `from` and unfinished: a
   * late overlapping run that wrote the same page finds it moved and stops. Null when it had moved.
   */
  advance(
    market: MarketContext,
    from: BackfillProgress,
    to: BackfillStep,
  ): Promise<BackfillProgress | null>;
}

export const BACKFILL_PROGRESS_STORE = Symbol('reporting.BackfillProgressStore');
