import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** One stored stock item of an Offer with the quantity held on it now. */
export interface OfferStockItem {
  readonly id: Id<'StockItem'>;
  readonly variantId: Id<'Variant'>;
  readonly sourceId: Id<'InventorySource'>;
  readonly onHand: number;
  readonly version: number;
  readonly retired: boolean;
  /** ACTIVE unexpired plus COMMITTED reservation lines (design 4.1). */
  readonly held: number;
}

/** What the seller's stock page reads of one Offer: items plus the catalog tombstones. */
export interface OfferStockSnapshot {
  /** An `offer` tombstone covers the Offer. */
  readonly offerRetired: boolean;
  readonly retiredVariantIds: ReadonlySet<Id<'Variant'>>;
  readonly items: readonly OfferStockItem[];
}

/** One sell unit of the seller whose published status is `low` or `out`. */
export interface LowStockSignal {
  readonly id: Id<'AvailabilitySignal'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly status: 'low' | 'out';
  /** Set for `low` only (1 to 99). */
  readonly onlyLeft: number | null;
  readonly changedAt: Temporal.Instant;
}

/** Most recently changed first; the cursor is the last row of the previous page. */
export interface LowStockPage {
  readonly limit: number;
  readonly after: {
    readonly changedAt: Temporal.Instant;
    readonly id: Id<'AvailabilitySignal'>;
  } | null;
}

/**
 * A plain read of the stock of one Offer of one seller (no lock, no write): for the read-only unit
 * of `inventory.view-offer-stock`. Held quantities are derived from `now`, never from a status.
 */
export interface OfferStockReader {
  read(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    offerId: Id<'Offer'>,
    variantIds: readonly Id<'Variant'>[],
    now: Temporal.Instant,
  ): Promise<OfferStockSnapshot>;

  /**
   * The seller's sell units whose signal is `low` or `out` (`status` keeps one), most recently
   * changed first. Returns up to `limit` signals; the caller pages on the last one.
   */
  listLowStock(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    status: 'low' | 'out' | null,
    page: LowStockPage,
  ): Promise<readonly LowStockSignal[]>;

  /**
   * Of the given sell units, the keys (`offerId:variantId`) that still have a stock item that is
   * not retired. A sell unit whose items are all retired is `out` for good and not the seller's
   * to restock.
   */
  liveSellUnits(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    keys: readonly { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> }[],
  ): Promise<ReadonlySet<string>>;
}

export const OFFER_STOCK_READER = Symbol('OFFER_STOCK_READER');
