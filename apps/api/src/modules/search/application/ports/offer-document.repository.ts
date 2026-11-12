import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { OfferDocument } from '../../domain/offer-document';

/** The store of the read model. Every call is for the Market of the open unit. */
export interface OfferDocumentRepository {
  /**
   * Writes the document as read at `indexedAt` (the instant its sync began reading). A stored
   * document written from a later read is kept (multi-culture package 3a, security review L2: two
   * syncs of one Offer that overlap never leave the older answer last); equal instants overwrite.
   */
  upsert(
    market: MarketContext,
    document: OfferDocument,
    indexedAt: Temporal.Instant,
  ): Promise<void>;
  /**
   * Removes the documents of these Offers; absent ones are ignored. With `readAt`, a document
   * written from a later read is kept (L2, as for {@link upsert}).
   */
  deleteMany(
    market: MarketContext,
    offerIds: readonly Id<'Offer'>[],
    readAt?: Temporal.Instant,
  ): Promise<number>;
  /** The Offers of this product that have a document (so a changed product can drop stale ones). */
  offerIdsOfProduct(
    market: MarketContext,
    productId: Id<'Product'>,
  ): Promise<readonly Id<'Offer'>[]>;
  /** The Offers of this seller that have a document (so a suspension can drop them). */
  offerIdsOfSeller(market: MarketContext, sellerId: Id<'Seller'>): Promise<readonly Id<'Offer'>[]>;
  /**
   * Up to `limit` Offers whose document names one of these categories, by Offer id after `after`
   * (search 1a: a category rename; package 3a: a culture mark, a merge or an archive). Keyset paged.
   */
  offerIdsInCategories(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
    limit: number,
    after?: Id<'Offer'>,
  ): Promise<readonly Id<'Offer'>[]>;
  /**
   * Up to `limit` Offers whose document holds this culture code, by Offer id after `after`
   * (multi-culture package 3a; the query shape of the 3b filter, `culture_codes @> ARRAY[code]`,
   * served by the GIN index).
   */
  offerIdsWithCultureCode(
    market: MarketContext,
    cultureCode: string,
    limit: number,
    after?: Id<'Offer'>,
  ): Promise<readonly Id<'Offer'>[]>;
  /** Removes up to `limit` documents last written before `before`; returns how many. */
  deleteIndexedBefore(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<number>;
}

export const OFFER_DOCUMENT_REPOSITORY = Symbol('OFFER_DOCUMENT_REPOSITORY');
