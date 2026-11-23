import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  LedgerReportEntry,
  LedgerReportPage,
  LedgerReportWindow,
} from '../../contracts/commission-payouts-reporting.facade';

/**
 * The reads behind reporting's ledger facts (dashboards v2, phase 1, PR 4): the reportable rows of
 * some seller orders, and the reportable rows recorded in a window keyset-paged by entry id. Runs
 * in a read-only unit, scoped to the Market.
 */
export interface LedgerReportReader {
  entriesOf(
    market: MarketContext,
    sellerOrderIds: readonly Id<'SellerOrder'>[],
  ): Promise<readonly LedgerReportEntry[]>;
  entriesRecorded(
    market: MarketContext,
    window: LedgerReportWindow,
    after: Id<'LedgerEntry'> | null,
    limit: number,
  ): Promise<LedgerReportPage>;
}

export const LEDGER_REPORT_READER = Symbol('commission-payouts.LedgerReportReader');
