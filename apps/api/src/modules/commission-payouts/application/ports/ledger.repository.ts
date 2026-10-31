import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { LedgerEntry, LedgerKind } from '../../domain/ledger';

/** Newest first; the cursor is the last row of the previous page. */
export interface LedgerPage {
  readonly limit: number;
  readonly after: { readonly recordedAt: Temporal.Instant; readonly id: Id<'LedgerEntry'> } | null;
}

/** The sum of one seller's rows per kind and currency. */
export interface LedgerSum {
  readonly currency: string;
  readonly kind: LedgerKind;
  readonly amount: bigint;
}

/**
 * The seller ledger of one Market (`commission_payouts.ledger_entries`): insert-only. The
 * database refuses any change or delete of a row and the application role holds no such grant.
 */
export interface LedgerRepository {
  /** Whether the seller order already has its rows (the idempotency check). */
  hasSellerOrder(market: MarketContext, sellerOrderId: Id<'SellerOrder'>): Promise<boolean>;

  /** The seller a seller order's rows belong to in this Market, or null when it has none. */
  sellerOfSellerOrder(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
  ): Promise<Id<'Seller'> | null>;

  /** Every row of the seller order (paid facts and reversals), oldest first. */
  listSellerOrder(
    market: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
  ): Promise<readonly LedgerEntry[]>;

  /**
   * Inserts the rows of one fact. A row that exists already (same seller order, kind, line and
   * source) is skipped (INSERT ... ON CONFLICT DO NOTHING), so a replay writes nothing twice.
   * Answers how many rows were inserted.
   */
  append(market: MarketContext, entries: readonly LedgerEntry[]): Promise<number>;

  list(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: LedgerPage,
  ): Promise<readonly LedgerEntry[]>;

  sums(market: MarketContext, sellerId: Id<'Seller'>): Promise<readonly LedgerSum[]>;

  /**
   * What each of the seller's seller orders is worth now in `currency`: its credits less its
   * debits (a refund or a dispute can take it below zero). The payout run's source of items and
   * of the receivable.
   */
  netBySellerOrder(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    currency: string,
  ): Promise<readonly SellerOrderNet[]>;
}

export interface SellerOrderNet {
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly net: bigint;
}

export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY');
