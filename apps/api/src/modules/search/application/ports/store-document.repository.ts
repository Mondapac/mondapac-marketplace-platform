import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { StoreDocument } from '../../domain/store-document';

/** The store of the store read model. Every call is for the Market of the open unit. */
export interface StoreDocumentRepository {
  /** Writes (inserts or replaces) the documents, stamped `indexedAt`. */
  upsertMany(
    market: MarketContext,
    documents: readonly StoreDocument[],
    indexedAt: Temporal.Instant,
  ): Promise<void>;
  /** Removes the documents of these sellers; absent ones are ignored. */
  deleteMany(market: MarketContext, sellerIds: readonly Id<'Seller'>[]): Promise<number>;
  /** Removes up to `limit` documents last written before `before`; returns how many. */
  deleteIndexedBefore(
    market: MarketContext,
    before: Temporal.Instant,
    limit: number,
  ): Promise<number>;
  /** The number of indexed Offers of each of these sellers (sellers with none are absent). */
  offerCounts(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, number>>;
}

export const STORE_DOCUMENT_REPOSITORY = Symbol('STORE_DOCUMENT_REPOSITORY');
