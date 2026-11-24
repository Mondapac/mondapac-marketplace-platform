import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { FactKind } from '../report-facts-sync';

/** The kind of the ledger history backfill (dashboards v2, phase 1, PR 4). */
export const LEDGER_BACKFILL_KIND = 'ledger';
export type BackfillKind = FactKind | typeof LEDGER_BACKFILL_KIND;

/** Where the history backfill of one kind of fact stands in one Market. */
export interface BackfillProgress<K extends BackfillKind = FactKind> {
  readonly kind: K;
  /** The window's end, fixed when the backfill started; later facts come from the worker. */
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
   * The progress of every kind, in the order of `FACT_KINDS`. A kind with none yet is started with
   * `until`, all in one unit so every kind shares one window end (a concurrent start keeps the
   * first). Once every kind has a row it only reads.
   */
  startAll(market: MarketContext, until: Temporal.Instant): Promise<readonly BackfillProgress[]>;
  /**
   * The progress of the ledger backfill, started with `until` when it has none (a concurrent start
   * keeps the first). Its window end is its own: the ledger backfill starts when it is deployed,
   * not with the sales backfill.
   */
  startLedger(
    market: MarketContext,
    until: Temporal.Instant,
  ): Promise<BackfillProgress<typeof LEDGER_BACKFILL_KIND>>;
  /**
   * Moves the progress on from `from` to `to`, only while it is still at `from` and unfinished: a
   * late overlapping run that wrote the same page finds it moved and stops. Null when it had moved.
   */
  advance<K extends BackfillKind>(
    market: MarketContext,
    from: BackfillProgress<K>,
    to: BackfillStep,
  ): Promise<BackfillProgress<K> | null>;
}

export const BACKFILL_PROGRESS_STORE = Symbol('reporting.BackfillProgressStore');
