import type { Id, MarketContext } from '@mondapac/shared-kernel';

/** One PLATFORM product as the seller's "Add offer" search shows it. */
export interface PlatformProductSearchRow {
  readonly productId: Id<'Product'>;
  readonly productCode: string;
  /** The published name in the asked locale, else null. */
  readonly name: string | null;
  readonly brandName: string | null;
  readonly categoryId: Id<'Category'> | null;
  readonly categoryName: string | null;
  /** The published revision's variants (sizes). */
  readonly variantCount: number;
  /** True when the seller already has a live (not deleted) Offer on the product. */
  readonly alreadySelling: boolean;
}

export interface PlatformProductSearchQuery {
  readonly sellerId: Id<'Seller'>;
  /** Only products with a category in this set are read (the seller's activity scope). */
  readonly allowedCategoryIds: ReadonlySet<Id<'Category'>>;
  readonly locale: string;
  /** A trimmed, non-empty search text, or null for "every product in scope". */
  readonly text: string | null;
  /** 14-digit forms of a typed barcode, matched exactly (derived from `text` by the caller). */
  readonly gtins: readonly string[];
  /** True leaves out (and does not count) the products the seller already sells. */
  readonly notSelling: boolean;
  readonly offset: number;
  readonly limit: number;
}

export interface PlatformProductSearchPage {
  readonly rows: readonly PlatformProductSearchRow[];
  readonly total: number;
}

export interface PlatformProductGtinMatch {
  readonly gtin: string;
  readonly row: PlatformProductSearchRow;
  /** False when the product is outside the seller's categories. */
  readonly inScope: boolean;
}

/**
 * The read behind the seller's platform-product search: published PLATFORM products only (never a
 * paused, retired or unpublished one, never a draft), narrowed to the categories the seller may
 * sell in. Runs in a read-only unit.
 */
export interface PlatformProductSearchReader {
  search(
    market: MarketContext,
    query: PlatformProductSearchQuery,
  ): Promise<PlatformProductSearchPage>;

  /** Which published PLATFORM products carry each of the 14-digit `gtins` (any scope). */
  lookupGtins(
    market: MarketContext,
    query: {
      readonly sellerId: Id<'Seller'>;
      readonly allowedCategoryIds: ReadonlySet<Id<'Category'>>;
      readonly locale: string;
      readonly gtins: readonly string[];
    },
  ): Promise<readonly PlatformProductGtinMatch[]>;
}

export const PLATFORM_PRODUCT_SEARCH_READER = Symbol('PLATFORM_PRODUCT_SEARCH_READER');
