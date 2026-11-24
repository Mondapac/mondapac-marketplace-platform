import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { LedgerFactKind } from '../../domain/ledger';
import type { SourcePage, SourceUnavailable, SourceWindow } from './report-sources';

/** The most seller orders one ledger read asks for (commission-payouts' cap). */
export const LEDGER_SOURCE_BATCH = 100;
/** The rows one page of the ledger backfill reads. */
export const LEDGER_PAGE = 200;

/** One ledger row as commission-payouts reports it: ids and money only. */
export interface LedgerSourceEntry {
  readonly entryId: Id<'LedgerEntry'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly kind: LedgerFactKind;
  readonly amount: bigint;
  readonly baseAmount: bigint | null;
  readonly currency: string;
  readonly occurredAt: Temporal.Instant;
}

/**
 * What reporting reads of the seller ledger, with the caller's system-actor context unchanged.
 * Bound in infrastructure to commission-payouts' reporting facade; never its table.
 */
export interface LedgerSources {
  /** The rows of at most {@link LEDGER_SOURCE_BATCH} seller orders. */
  entriesOf(
    context: CallContext,
    sellerOrderIds: readonly Id<'SellerOrder'>[],
  ): Promise<Result<readonly LedgerSourceEntry[], SourceUnavailable>>;
  /** The rows recorded in the window, by entry id after `after`. */
  entriesRecorded(
    context: CallContext,
    window: SourceWindow,
    after: string | null,
    limit: number,
  ): Promise<Result<SourcePage<LedgerSourceEntry>, SourceUnavailable>>;
}

export const LEDGER_SOURCES = Symbol('reporting.LedgerSources');
