import type { MarketContext } from '@mondapac/shared-kernel';

/** One published product as the "missing required details" report reads it. */
export interface PublishedProductValues {
  readonly productId: string;
  readonly productCode: string;
  /** The owning seller; null for a PLATFORM product. */
  readonly ownerSellerId: string | null;
  /** The feature set the product was made under (immutable on the product). */
  readonly familyCode: string;
  /** The published revision's name in the asked locale; null when it has none. */
  readonly name: string | null;
  /** The published revision's attribute values, as stored. */
  readonly attributeValues: unknown;
}

export interface PublishedProductsFilter {
  /** Products with an id after this one, by id; null for the first page. */
  readonly afterId: string | null;
  readonly sellerId: string | null;
  readonly familyCode: string | null;
  readonly limit: number;
  /** The locale of the name (the Market's default). */
  readonly locale: string;
}

/**
 * The published products and their published attribute values, by id, for the report "Products
 * missing required details" (attributes plan, package A4, decision ت۷). Runs in the open
 * (read-only) unit of the use case, through the Market-scoped client. Catalog tables only.
 */
export interface ProductDetailsGapReader {
  published(
    market: MarketContext,
    filter: PublishedProductsFilter,
  ): Promise<readonly PublishedProductValues[]>;
}

export const PRODUCT_DETAILS_GAP_READER = Symbol('PRODUCT_DETAILS_GAP_READER');
