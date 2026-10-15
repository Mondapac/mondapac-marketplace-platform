import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { OfferDocument } from '../../domain/offer-document';

/** The store of the read model. Every call is for the Market of the open unit. */
export interface OfferDocumentRepository {
  upsert(
    market: MarketContext,
    document: OfferDocument,
    indexedAt: Temporal.Instant,
  ): Promise<void>;
  /** Removes the documents of these Offers; absent ones are ignored. */
  deleteMany(market: MarketContext, offerIds: readonly Id<'Offer'>[]): Promise<number>;
  /** The Offers of this product that have a document (so a changed product can drop stale ones). */
  offerIdsOfProduct(
    market: MarketContext,
    productId: Id<'Product'>,
  ): Promise<readonly Id<'Offer'>[]>;
  /** Removes up to `limit` documents last written before `before`; returns how many. */
  deleteIndexedBefore(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<number>;
}

export const OFFER_DOCUMENT_REPOSITORY = Symbol('OFFER_DOCUMENT_REPOSITORY');
