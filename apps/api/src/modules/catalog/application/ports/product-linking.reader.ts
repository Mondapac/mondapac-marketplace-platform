import type { Id, MarketContext } from '@mondapac/shared-kernel';

import type { ProductLinkFacts } from '../../contracts/catalog.facade';

export type { ProductLinkFacts };

/**
 * The read behind `productsForLinking`: per requested product of the Market that is published,
 * whether it is on sale and whether the given seller sells it. An unknown product, another
 * Market's and a product that is not published are absent. Runs in a read-only unit.
 */
export interface ProductLinkingReader {
  read(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
    sellerId: Id<'Seller'> | null,
  ): Promise<ReadonlyMap<Id<'Product'>, ProductLinkFacts>>;
}

export const PRODUCT_LINKING_READER = Symbol('PRODUCT_LINKING_READER');
