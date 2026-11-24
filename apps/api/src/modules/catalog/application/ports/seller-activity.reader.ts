import type { CallContext, Id, Result } from '@mondapac/shared-kernel';

/** The assignment could not be read: the caller allows no category (fail closed). */
export interface SellerActivityUnavailable {
  readonly code: 'access.unavailable';
}

/**
 * The catalog's question to `sellers` about a seller's business activities (ADR-0040 decision 4:
 * `sellers` owns the assignment, `catalog` owns the activities and their category links). The
 * adapter asks `sellers.sellerBusinessActivities` with the caller's context unchanged and opens
 * no unit here: the facade opens its own read-only unit, so the caller holds none open while
 * asking. A seller with no activity answers an empty list; any refusal, missing entry or fault is
 * `access.unavailable`, never "every category".
 */
export interface SellerActivityReader {
  activityIdsOf(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<Result<readonly Id<'BusinessActivity'>[], SellerActivityUnavailable>>;
}

export const SELLER_ACTIVITY_READER = Symbol('SELLER_ACTIVITY_READER');
