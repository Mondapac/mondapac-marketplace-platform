import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  MarketDay,
  RefundFact,
  SalesEntry,
  SalesEntryKind,
  SellerOrderFact,
  SellerOrderInstants,
} from '../../domain/facts';
import type { SellerDay, SellerDayFacts } from '../../domain/rollup';

/**
 * The facts of `reporting` (tables `seller_orders`, `refunds`, `sales_entries`). Every method runs
 * inside the caller's unit and is scoped to its Market. Each write returns the seller days the
 * stored fact touched BEFORE the write, so the caller can refresh a day a fact moved away from.
 */
export interface FactStore {
  /** The instants of the stored seller order, or null when it is not recorded yet. */
  sellerOrderInstants(
    market: MarketContext,
    sellerOrderId: SellerOrderFact['sellerOrderId'],
  ): Promise<SellerOrderInstants | null>;
  /** Inserts or rewrites the seller order (its keys and first record time stay). */
  putSellerOrder(
    market: MarketContext,
    fact: SellerOrderFact,
    days: SellerOrderDays,
  ): Promise<readonly SellerDay[]>;
  /** Inserts or rewrites the refund. */
  putRefund(
    market: MarketContext,
    fact: RefundFact,
    refundDay: MarketDay,
  ): Promise<readonly SellerDay[]>;
  /** Replaces every entry of one source (a seller order's sales, or a refund) with `entries`. */
  replaceEntries(
    market: MarketContext,
    kind: SalesEntryKind,
    sourceId: string,
    entries: readonly SalesEntry[],
  ): Promise<readonly SellerDay[]>;
  /**
   * The seller orders recorded before the delivery columns (no delivery method), by seller order id after
   * `after`, at most `limit` (the delivery pass of the backfill). `next` is the last id of a full
   * page, null on the last page.
   */
  sellerOrdersMissingDelivery(
    market: MarketContext,
    after: string | null,
    limit: number,
  ): Promise<{
    readonly items: readonly { readonly orderId: string; readonly sellerOrderId: string }[];
    readonly next: string | null;
  }>;
  /** Every fact of one seller that falls on one Market day. */
  loadSellerDay(market: MarketContext, key: SellerDay): Promise<SellerDayFacts>;
}

/** The Market days of a seller order's instants, computed by the caller from the Market's zone. */
export interface SellerOrderDays {
  readonly paidDay: MarketDay | null;
  readonly cancelledDay: MarketDay | null;
  readonly shippedDay: MarketDay | null;
  readonly deliveredDay: MarketDay | null;
}

export const FACT_STORE = Symbol('reporting.FactStore');

/**
 * Thrown when a fact names another order, seller or currency than the one stored under its key:
 * a bug upstream. It fails the unit, so nothing is written and the delivery is retried, then
 * dead-lettered with an alert.
 */
export class ReportingFactConflict extends Error {
  constructor(
    readonly kind: 'seller-order' | 'refund',
    readonly id: string,
  ) {
    super(`reporting: the ${kind} ${id} conflicts with the stored fact`);
    this.name = 'ReportingFactConflict';
  }
}
