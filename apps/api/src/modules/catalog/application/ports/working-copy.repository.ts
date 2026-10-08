import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { WorkingCopy } from '../../domain/working-copy';

/**
 * The store of working copies (catalog data design 3.6). Every method runs in the open unit of the
 * caller, through the Market-scoped client. The row is deleted only by a discard or the prune job
 * (later slices).
 */
export interface WorkingCopyRepository {
  /** The working copy of a product in this Market, or null. */
  find(market: MarketContext, productId: Id<'Product'>): Promise<WorkingCopy | null>;

  /** Stores the draft over the previous one of the product (one row per product). */
  save(market: MarketContext, copy: WorkingCopy): Promise<void>;
}

export const WORKING_COPY_REPOSITORY = Symbol('WORKING_COPY_REPOSITORY');
