import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  MarketDay,
  RefundFact,
  SalesEntry,
  SalesEntryKind,
  SellerOrderFact,
} from '../../domain/facts';
import type { SellerDay, SellerDayFacts } from '../../domain/rollup';

/**
 * The facts of `reporting` (tables `seller_orders`, `refunds`, `sales_entries`). Every method runs
 * inside the caller's unit and is scoped to its Market. Each write returns the seller days the
 * stored fact touched BEFORE the write, so the caller can refresh a day a fact moved away from.
 */
export interface FactStore {
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
