import type { CallContext, Id } from '@mondapac/shared-kernel';

export interface FeedFacts {
  readonly sellerId: Id<'Seller'>;
  readonly productId: Id<'Product'>;
  readonly sellable: boolean;
  readonly name: string | null;
  readonly shortText: string | null;
  readonly categoryIds: readonly Id<'Category'>[];
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
  /** One page of the ids of published Offers (any product, or one), after `after`. */
  publishedIds(
    context: CallContext,
    input: { productId?: Id<'Product'>; after?: Id<'Offer'>; limit: number },
  ): Promise<readonly Id<'Offer'>[] | null>;
}

export const OFFER_FEED = Symbol('OFFER_FEED');
