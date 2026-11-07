import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { SellerCheckFacts } from '../../domain/seller-import/row-check';

/**
 * The facts a check of the seller import needs about the seller's own Offers and the catalogue
 * (catalog design 14c). One read for the SKUs and product codes of a batch of groups, so a file of
 * thousands of rows costs a few statements. Read in the caller's unit. Only the seller's own
 * Offers are read: another seller's SKU is never visible, and a product code that is not an
 * eligible PLATFORM product is simply absent, whatever the reason.
 */
export interface SellerImportFactsReader {
  load(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    keys: { readonly skus: readonly string[]; readonly productCodes: readonly string[] },
  ): Promise<SellerCheckFacts>;
}

export const SELLER_IMPORT_FACTS_READER = Symbol('CATALOG_SELLER_IMPORT_FACTS_READER');
