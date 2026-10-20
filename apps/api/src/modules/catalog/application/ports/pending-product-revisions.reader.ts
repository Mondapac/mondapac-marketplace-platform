import type { Id, MarketContext } from '@mondapac/shared-kernel';

/** One product revision, named with its product (so the read is a lookup by product id). */
export interface ProductRevisionRef {
  readonly productId: Id<'Product'>;
  readonly revisionId: Id<'ProductRevision'>;
}

/**
 * The read behind `pendingProductRevisions`: which of the given revisions is, right now, the
 * pending revision of its product (waiting for review). An unknown product, another Market's, a
 * published or a replaced revision is absent. Runs in a read-only unit.
 */
export interface PendingProductRevisionsReader {
  read(
    market: MarketContext,
    revisions: readonly ProductRevisionRef[],
  ): Promise<ReadonlySet<Id<'ProductRevision'>>>;
}

export const PENDING_PRODUCT_REVISIONS_READER = Symbol('PENDING_PRODUCT_REVISIONS_READER');
