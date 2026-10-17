import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Offer } from '../../domain/offer';

/**
 * The seller's Offer on a product (catalog design 5.1a; 4.2 row 1): at most one that is not
 * deleted per (Market, seller, product), OFR-02. Read with its open tags, in the caller's unit.
 */
export interface OwnOfferFinder {
  findOwnOnProduct(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    productId: Id<'Product'>,
  ): Promise<Offer | null>;
}

export const OWN_OFFER_FINDER = Symbol('OWN_OFFER_FINDER');
