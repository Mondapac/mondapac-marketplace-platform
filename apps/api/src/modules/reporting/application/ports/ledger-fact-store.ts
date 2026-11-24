import type { MarketContext } from '@mondapac/shared-kernel';
import type { LedgerDayTotals, LedgerFact } from '../../domain/ledger';
import type { SellerDay } from '../../domain/rollup';

/**
 * The ledger facts and their daily rollup (tables `reporting.ledger_entries` and
 * `reporting.daily_ledger`). Inside the caller's unit, scoped to its Market.
 */
export interface LedgerFactStore {
  /**
   * Inserts the facts not stored yet (a stored one is left as it is: a ledger row never changes)
   * and throws {@link ReportingLedgerConflict} when a stored one differs from the one read.
   */
  putEntries(market: MarketContext, facts: readonly LedgerFact[]): Promise<void>;
  /** Every fact of one seller on one Market day. */
  loadSellerDay(market: MarketContext, key: SellerDay): Promise<readonly LedgerFact[]>;
  /** Makes the rollup rows of one seller day exactly `rows` (delete and insert). */
  replaceSellerDay(
    market: MarketContext,
    key: SellerDay,
    rows: readonly LedgerDayTotals[],
  ): Promise<void>;
}

export const LEDGER_FACT_STORE = Symbol('reporting.LedgerFactStore');

/**
 * A ledger row read again that differs from the stored one: the ledger is insert-only, so this is
 * a bug upstream. It fails the unit; the delivery is retried then dead-lettered, the backfill
 * counts it as refused.
 */
export class ReportingLedgerConflict extends Error {
  constructor(readonly entryId: string) {
    super(`reporting: the ledger entry ${entryId} conflicts with the stored fact`);
    this.name = 'ReportingLedgerConflict';
  }
}
