import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  ReportCheckout,
  ReportChangesPage,
  ReportWindow,
  SellerOrderRef,
} from '../../contracts/ordering-reporting.facade';

/**
 * The reads behind reporting's reconcile and backfill: which seller orders and refunds changed in
 * a window, keyset-paged by id. Runs in a read-only unit, scoped to the Market.
 */
export interface ReportingChangesReader {
  /** Seller orders paid, ready, shipped or delivered, or of an order cancelled, in the window. */
  sellerOrdersChanged(
    market: MarketContext,
    window: ReportWindow,
    after: Id<'SellerOrder'> | null,
    limit: number,
  ): Promise<ReportChangesPage<SellerOrderRef>>;
  /** Refunds that succeeded in the window. */
  refundsSucceeded(
    market: MarketContext,
    window: ReportWindow,
    after: Id<'Refund'> | null,
    limit: number,
  ): Promise<ReportChangesPage<Id<'Refund'>>>;
  /**
   * The accounts with an order created in `[from, to)`, each once and by account id, with whether
   * one of those orders was confirmed; at most `limit`.
   */
  checkoutsStarted(
    market: MarketContext,
    window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant },
    limit: number,
  ): Promise<ReportCheckout[]>;
}

export const REPORTING_CHANGES_READER = Symbol('REPORTING_CHANGES_READER');
