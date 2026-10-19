import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * The read behind `pendingProductRevisions`: which of the given revisions is, right now, the
 * pending revision of its product (waiting for review). An unknown id, another Market's, a
 * published or a replaced revision is absent. Runs in a read-only unit.
 */
export interface PendingProductRevisionsReader {
  read(
    market: MarketContext,
    revisionIds: readonly Id<'ProductRevision'>[],
  ): Promise<ReadonlySet<Id<'ProductRevision'>>>;
}

export const PENDING_PRODUCT_REVISIONS_READER = Symbol('PENDING_PRODUCT_REVISIONS_READER');
