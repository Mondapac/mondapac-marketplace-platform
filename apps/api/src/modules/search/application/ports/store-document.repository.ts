import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { StoreDocument } from '../../domain/store-document';

/**
 * A store row write met a concurrent one on a unique key (search 1a follow-up, Mojtaba): another
 * sync handed the same store address to another seller, or inserted the same seller's row first,
 * and committed while this write waited. The unit is rolled back; the caller re-reads sellers and
 * writes the batch again, so the newer holder wins.
 */
export class StoreRowConflictError extends Error {
  override readonly name = 'StoreRowConflictError';
  constructor() {
    super('search: a store row was written by a concurrent sync');
  }
}

/** The store of the store read model. Every call is for the Market of the open unit. */
export interface StoreDocumentRepository {
  /**
   * Writes (inserts or replaces) the documents, stamped `indexedAt`, in seller id order, so two
   * syncs that write the same stores lock their rows in the same order. A row that another sync
   * wrote meanwhile under a unique key (address or seller) throws {@link StoreRowConflictError}.
   */
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
