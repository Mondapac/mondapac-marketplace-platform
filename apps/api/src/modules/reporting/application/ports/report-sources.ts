import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { CategoryGoods, RefundFact, SellerOrderFact } from '../../domain/facts';

/** The most seller orders or refunds one source call reads (ordering's `MAX_REPORT_FACTS`). */
export const SOURCE_BATCH = 100;

/** A seller order to read, or (`sellerOrderId` null) every seller order of the order. */
export interface SellerOrderSourceRef {
  readonly orderId: string;
  readonly sellerOrderId: string | null;
}

/** A seller order as its owners report it now, with its goods placed in categories. */
export interface SellerOrderSource {
  readonly order: SellerOrderFact;
  readonly goods: readonly CategoryGoods[];
}

/** A succeeded refund as ordering reports it now, with its goods placed in categories. */
export interface RefundSource {
  readonly refund: RefundFact;
  readonly goods: readonly CategoryGoods[];
}

/** A half-open window `[from, to)`; `from` null is the whole history (the backfill). */
export interface SourceWindow {
  readonly from: Temporal.Instant | null;
  readonly to: Temporal.Instant;
}

export interface SourcePage<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

/** An owner refused or failed: the caller retries later (the delivery, the next run). */
export interface SourceUnavailable {
  readonly code: 'reporting.source-unavailable';
  readonly cause: string;
}

/**
 * What reporting reads of the owners (ordering and catalog), with the caller's system-actor context
 * unchanged. Bound in infrastructure to the owners' public facades; never a table of theirs. Goods
 * whose category cannot be read are placed in `UNKNOWN_CATEGORY`, and goods by category always add
 * up to the fact's goods.
 */
export interface ReportSources {
  /** At most {@link SOURCE_BATCH} refs. */
  sellerOrders(
    context: CallContext,
    refs: readonly SellerOrderSourceRef[],
  ): Promise<Result<readonly SellerOrderSource[], SourceUnavailable>>;
  /** At most {@link SOURCE_BATCH} ids; a refund that has not succeeded is absent. */
  refunds(
    context: CallContext,
    refundIds: readonly string[],
  ): Promise<Result<readonly RefundSource[], SourceUnavailable>>;
  /** The seller orders with an instant in the window, by id after `after`. */
  changedSellerOrders(
    context: CallContext,
    window: SourceWindow,
    after: string | null,
    limit: number,
  ): Promise<Result<SourcePage<SellerOrderSourceRef>, SourceUnavailable>>;
  /** The refunds that succeeded in the window, by id after `after`. */
  succeededRefunds(
    context: CallContext,
    window: SourceWindow,
    after: string | null,
    limit: number,
  ): Promise<Result<SourcePage<string>, SourceUnavailable>>;
}

export const REPORT_SOURCES = Symbol('REPORT_SOURCES');
