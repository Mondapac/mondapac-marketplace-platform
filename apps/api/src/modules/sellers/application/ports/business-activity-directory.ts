import type { CallContext, Id, Result } from '@mondapac/shared-kernel';

/** The directory could not answer: no partial answer, and the assignment is refused (fail closed). */
export interface BusinessActivityDirectoryUnavailable {
  readonly code: 'business-activity-directory.unavailable';
}

/**
 * Which activity ids exist in the context's Market and are ACTIVE (ADR-0040: `catalog` owns the
 * activities). Bound to catalog's `activeBusinessActivityIds` by `SellerStoreProfileModule`
 * (catalog imports sellers, so sellers cannot import catalog's module). The adapter opens a
 * read-only unit of its own, so the caller holds no unit open while asking.
 */
export interface BusinessActivityDirectory {
  activeIds(
    context: CallContext,
    activityIds: readonly Id<'BusinessActivity'>[],
  ): Promise<Result<ReadonlySet<Id<'BusinessActivity'>>, BusinessActivityDirectoryUnavailable>>;
}

export const BUSINESS_ACTIVITY_DIRECTORY = Symbol('BUSINESS_ACTIVITY_DIRECTORY');
