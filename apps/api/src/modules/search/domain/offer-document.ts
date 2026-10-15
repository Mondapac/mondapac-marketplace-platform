import type { Id } from '@mondapac/shared-kernel';

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

/** Clips a text to a limit by characters (code points), never in the middle of one. */
export function clip(value: string, limit: number): string {
  const characters = [...value.trim()];
  return characters.length <= limit ? characters.join('') : characters.slice(0, limit).join('');
}
