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
}

export const OFFER_STOCK_READER = Symbol('OFFER_STOCK_READER');
