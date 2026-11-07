import type { Id, MarketContext } from '@mondapac/shared-kernel';

/** What the seller sell-unit read needs of a product and is in no other reader. */
export interface ProductSellUnitFacts {
  readonly scope: 'PLATFORM' | 'SELLER';
  readonly productCode: string;
  /** The non-retired variants with their number within the product. */
  readonly variants: readonly { readonly variantId: Id<'Variant'>; readonly variantNo: number }[];
}

/**
 * The read behind `own-offer.read-sell-units` for what the other readers lack: the product's scope
 * and code, and the number of each non-retired variant. Null when the product is not in the
 * Market. Runs in a read-only unit (ADR-0025).
 */
export interface ProductSellUnitFactsReader {
  read(market: MarketContext, productId: Id<'Product'>): Promise<ProductSellUnitFacts | null>;
}

export const PRODUCT_SELL_UNIT_FACTS_READER = Symbol('PRODUCT_SELL_UNIT_FACTS_READER');
