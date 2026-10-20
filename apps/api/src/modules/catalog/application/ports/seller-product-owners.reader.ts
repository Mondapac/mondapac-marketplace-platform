import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * The read behind `sellerProductOwners`: the owning seller of each given SELLER product of the
 * Market. A PLATFORM product, an unknown one and another Market's are absent. Runs in a
 * read-only unit.
 */
export interface SellerProductOwnersReader {
  read(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<ReadonlyMap<Id<'Product'>, Id<'Seller'>>>;
}

export const SELLER_PRODUCT_OWNERS_READER = Symbol('SELLER_PRODUCT_OWNERS_READER');
