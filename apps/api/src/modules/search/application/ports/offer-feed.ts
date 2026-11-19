import type { CallContext, Id } from '@mondapac/shared-kernel';

/** One published variant of a sellable Offer's product (variants V8), in position order. */
export interface FeedVariant {
  readonly variantId: Id<'Variant'>;
  readonly position: number;
  readonly label: string | null;
  /** 14 digits, or null. */
  readonly gtin: string | null;
  /** The axis values as `attribute=<option code>`. */
  readonly facets: readonly string[];
}

export interface FeedFacts {
  readonly sellerId: Id<'Seller'>;
  readonly productId: Id<'Product'>;
  readonly sellable: boolean;
  readonly name: string | null;
  readonly shortText: string | null;
  readonly categoryIds: readonly Id<'Category'>[];
  /** What the index keeps of the product's attributes (attributes A7). */
  readonly attributes: {
    readonly searchText: string;
    readonly facets: readonly string[];
    readonly numbers: Readonly<Record<string, number>>;
  };
  /** Empty when the Offer is not sellable. */
  readonly variants: readonly FeedVariant[];
}

/**
 * What catalog tells the index (through its index facade). A failed read is `null`, never a
 * partial answer: the caller throws so the delivery is retried.
 */
export interface OfferFeed {
  /** The facts of each Offer found in the context's Market, text in `locale`; absent = unknown. */
  facts(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
    locale: string,
  ): Promise<ReadonlyMap<Id<'Offer'>, FeedFacts> | null>;
  /** One page of the ids of published Offers (any, of one product or of one seller), after `after`. */
  publishedIds(
    context: CallContext,
    input: {
      productId?: Id<'Product'>;
      sellerId?: Id<'Seller'>;
      after?: Id<'Offer'>;
      limit: number;
    },
  ): Promise<readonly Id<'Offer'>[] | null>;
}

export const OFFER_FEED = Symbol('OFFER_FEED');
