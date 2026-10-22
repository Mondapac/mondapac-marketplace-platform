import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { OfferHit } from '../../domain/offer-document';

/**
 * The documents a shelf is drawn from (the module's own read model). Runs in the caller's
 * read-only unit; documents of this Market only; `rank` is 0.
 */
export interface ShelfDocumentsReader {
  /** The documents of these Offers that are indexed, in any order; absent ones are left out. */
  byOfferIds(market: MarketContext, offerIds: readonly Id<'Offer'>[]): Promise<readonly OfferHit[]>;
  /** The documents of this product's Offers, by Offer id, at most `limit`. */
  byProductId(
    market: MarketContext,
    productId: Id<'Product'>,
    limit: number,
  ): Promise<readonly OfferHit[]>;
  /**
   * The documents of one seller's Offers (in one category when `categoryId` is set) in browse
   * order (name, then Offer id), `limit` rows from `offset`.
   */
  browseBySeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    categoryId: Id<'Category'> | null,
    limit: number,
    offset: number,
  ): Promise<readonly OfferHit[]>;
  /**
   * The documents of these products' Offers, at most `perProduct` of each product (by Offer id),
   * so no product loses its documents to another's: a cap on the whole answer would cut the
   * products with the highest ids. Products without an indexed Offer are left out. Documents of
   * this Market only; products in the order given, then Offer id.
   */
  byProductIds(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
    perProduct: number,
  ): Promise<readonly OfferHit[]>;
  /** The first `limit` documents of the Market in search's browse order (name, then Offer id). */
  browseAll(market: MarketContext, limit: number): Promise<readonly OfferHit[]>;
}

export const SHELF_DOCUMENTS_READER = Symbol('SHELF_DOCUMENTS_READER');
