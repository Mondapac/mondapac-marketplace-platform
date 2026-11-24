import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** The most seller orders one ledger facts call answers; more is refused. */
export const MAX_LEDGER_REPORT_SELLER_ORDERS = 100;
/** The most rows one page of recorded ledger rows holds. */
export const MAX_LEDGER_REPORT_PAGE = 500;

/**
 * The ledger kinds reporting reads (dashboards v2, phase 1): the platform's commission and what a
 * refund gave back of it, and the cashback a seller funds and what a refund returned of it. The
 * sale, shipping and dispute kinds are not read.
 */
export const LEDGER_REPORT_KINDS = [
  'commission',
  'refund-commission',
  'cashback-seller',
  'refund-cashback-seller',
] as const;
export type LedgerReportKind = (typeof LEDGER_REPORT_KINDS)[number];

export type LedgerReportFailure = AccessDenied | { readonly code: 'validation.failed' };

/**
 * One ledger row as reporting records it. Ids and money only: no order, line, rate, source,
 * customer or name. `amount` is never negative, the kind gives the direction, exactly as stored.
 * `baseAmount` is the commission base (goods without GST) of a `commission` or `refund-commission`
 * row, null for the cashback kinds. `occurredAt` is when the fact happened (the payment, the
 * refund, the wallet credit or its return).
 */
export interface LedgerReportEntry {
  readonly entryId: Id<'LedgerEntry'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly kind: LedgerReportKind;
  readonly amount: bigint;
  readonly baseAmount: bigint | null;
  readonly currency: string;
  readonly occurredAt: Temporal.Instant;
}

/** A half-open window `[from, to)` of record time; `from` null means from the first row. */
export interface LedgerReportWindow {
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant;
}

export interface LedgerReportPage {
  readonly entries: readonly LedgerReportEntry[];
  /** The entry id to pass as `after` for the next page; null on the last page. */
  readonly next: string | null;
}

/**
 * What `reporting` may read of the seller ledger (dashboards v2, phase 1, PR 4). Every method is
 * rule `system`: only reporting's event worker and ledger backfill call it, as the Market's
 * system actor. Not exposed over HTTP. Read only.
 */
export interface CommissionPayoutsReportingFacade {
  /**
   * The rows of {@link LEDGER_REPORT_KINDS} of each requested seller order (at most
   * {@link MAX_LEDGER_REPORT_SELLER_ORDERS}), in entry id order. A seller order the ledger does
   * not hold, or of another Market, has no rows.
   */
  ledgerReportEntries(
    context: CallContext,
    request: { readonly sellerOrderIds: readonly Id<'SellerOrder'>[] },
  ): Promise<Result<readonly LedgerReportEntry[], LedgerReportFailure>>;

  /**
   * The rows of {@link LEDGER_REPORT_KINDS} recorded in the window, by entry id after `after`, at
   * most `limit` (1 to {@link MAX_LEDGER_REPORT_PAGE}): the history backfill.
   */
  ledgerEntriesRecorded(
    context: CallContext,
    request: {
      readonly window: LedgerReportWindow;
      readonly after: string | null;
      readonly limit: number;
    },
  ): Promise<Result<LedgerReportPage, LedgerReportFailure>>;
}

/**
 * Nest token of the {@link CommissionPayoutsReportingFacade}, provided and exported by
 * `CommissionPayoutsModule`.
 */
export const COMMISSION_PAYOUTS_REPORTING_FACADE = Symbol('COMMISSION_PAYOUTS_REPORTING_FACADE');
