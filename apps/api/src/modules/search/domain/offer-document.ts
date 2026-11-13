import type { Id, Money } from '@mondapac/shared-kernel';

/**
 * One sell unit of a document (variants V8): a published variant of the Offer's product with what a
 * filter and a card read of it. `inStock` is inventory's public status (`in-stock` or `low`);
 * `price` is pricing's effective price, or null when none is in force. Only a unit that is in stock
 * and priced can match a variant filter, the price filter or give the card's "From" price.
 */
export interface OfferVariantDocument {
  readonly variantId: Id<'Variant'>;
  readonly position: number;
  /** The axis values as `attribute=<option code>`. */
  readonly facetCodes: readonly string[];
  /** 14 digits, or null. */
  readonly gtin: string | null;
  readonly inStock: boolean;
  readonly price: Money | null;
}

/** One row of the read model: what a storefront result shows for a sellable Offer. */
export interface OfferDocument {
  readonly offerId: Id<'Offer'>;
  readonly productId: Id<'Product'>;
  readonly sellerId: Id<'Seller'>;
  /** The locale of `name` and `shortText`: the Market's default locale. */
  readonly locale: string;
  readonly name: string;
  readonly shortText: string | null;
  readonly categoryIds: readonly Id<'Category'>[];
  /** The text search configuration of the Market the vector is built with. */
  readonly textSearchConfig: string;
  /** Searchable attribute values as words (brand and aliases, country, option labels); or null. */
  readonly searchText: string | null;
  /** Facet values as `attribute=value` (option codes, `true`, `brand=<slug>`, `country-of-origin=<iso>`). */
  readonly facetCodes: readonly string[];
  /** The numbers a range filter reads, by attribute code. */
  readonly numbers: Readonly<Record<string, number>>;
  /** The sell units, in position order (V8). */
  readonly variants: readonly OfferVariantDocument[];
  /**
   * The codes of the cultures the Offer is visible in (multi-culture package 3a), from catalog's
   * visibility facade at indexing time; empty when it is visible in none.
   */
  readonly cultureCodes: readonly string[];
}

/** A hit of a query: a document without the index fields, plus its rank. */
export interface OfferHit {
  readonly offerId: Id<'Offer'>;
  readonly productId: Id<'Product'>;
  readonly sellerId: Id<'Seller'>;
  readonly name: string;
  readonly shortText: string | null;
  readonly categoryIds: readonly Id<'Category'>[];
  readonly rank: number;
}

/** The longest name and short text indexed (the column CHECKs state the same limits). */
export const MAX_NAME = 500;
export const MAX_SHORT_TEXT = 2000;
export const MAX_DOCUMENT_CATEGORIES = 20;
export const MAX_FACET_CODES = 100;
/** The most sell units one document keeps (the Market variant cap is 100). */
export const MAX_DOCUMENT_VARIANTS = 100;
/** The most axis facets one sell unit keeps (a product has at most two axes). */
export const MAX_VARIANT_FACETS = 4;
/** The most culture codes one document keeps (a Market holds at most 200 cultures; CHECK). */
export const MAX_CULTURE_CODES = 200;

/** Clips a text to a limit by characters (code points), never in the middle of one. */
export function clip(value: string, limit: number): string {
  const characters = [...value.trim()];
  return characters.length <= limit ? characters.join('') : characters.slice(0, limit).join('');
}
