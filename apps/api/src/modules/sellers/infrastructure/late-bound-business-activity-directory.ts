import { err } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type {
  BusinessActivityDirectory,
  BusinessActivityDirectoryUnavailable,
} from '../application/ports/business-activity-directory';

/**
 * The directory as `SellersModule` provides it: it answers `unavailable` until
 * `SellerStoreProfileModule` binds the real one (over catalog's `activeBusinessActivityIds`) at
 * start. Sellers cannot import catalog's module (catalog imports sellers), so the binding is made
 * from outside; until it is made an assignment is refused, never let through (fail closed).
 */
export class LateBoundBusinessActivityDirectory implements BusinessActivityDirectory {
  #bound: BusinessActivityDirectory | null = null;

  /** Binds the real directory once; a second bind is a wiring fault and throws. */
  bind(directory: BusinessActivityDirectory): void {
    if (this.#bound !== null) {
      throw new Error('LateBoundBusinessActivityDirectory is already bound');
    }
    this.#bound = directory;
  }

  activeIds(
    context: CallContext,
    activityIds: readonly Id<'BusinessActivity'>[],
  ): Promise<Result<ReadonlySet<Id<'BusinessActivity'>>, BusinessActivityDirectoryUnavailable>> {
    if (this.#bound === null) {
      return Promise.resolve(err({ code: 'business-activity-directory.unavailable' } as const));
    }
    return this.#bound.activeIds(context, activityIds);
  }
}
