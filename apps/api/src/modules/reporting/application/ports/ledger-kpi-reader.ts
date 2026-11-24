import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { LedgerBackfillState, LedgerKindSums, PaidOnDay } from '../../domain/ledger';
import type { DayRange } from '../../domain/period';

/** The range's sums per kind and when the newest rollup row behind them was rebuilt. */
export interface LedgerRangeSums {
  readonly sums: LedgerKindSums;
  readonly refreshedAt: Temporal.Instant | null;
}

/** What the readiness compares, for the days of a window. */
export interface LedgerMatchFacts {
  /** Seller orders paid on a day of the window with goods above zero. */
  readonly paid: readonly PaidOnDay[];
  /** Seller orders with a `commission` fact on a day of the window. */
  readonly commission: readonly PaidOnDay[];
  /** Of the commission seller orders not paid in the window, those reporting holds unpaid. */
  readonly knownUnpaid: ReadonlySet<string>;
}

/** The reads of the net figures. Inside a read-only unit, scoped to the Market. */
export interface LedgerKpiReader {
  /** The range summed per kind in `currency`, every seller or one seller. */
  rangeSums(
    market: MarketContext,
    currency: string,
    range: DayRange,
    sellerId: Id<'Seller'> | null,
  ): Promise<LedgerRangeSums>;
  /** The facts the readiness window is compared from. */
  matchFacts(market: MarketContext, currency: string, window: DayRange): Promise<LedgerMatchFacts>;
  /** Whether the ledger history backfill of the Market has finished, and the rows it refused. */
  backfillState(market: MarketContext): Promise<LedgerBackfillState>;
}

export const LEDGER_KPI_READER = Symbol('reporting.LedgerKpiReader');
