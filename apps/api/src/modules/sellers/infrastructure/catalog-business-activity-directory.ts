import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { CatalogActivitiesFacade } from '../../catalog';
import type {
  BusinessActivityDirectory,
  BusinessActivityDirectoryUnavailable,
} from '../application/ports/business-activity-directory';

const UNAVAILABLE = err({ code: 'business-activity-directory.unavailable' } as const);

/**
 * {@link BusinessActivityDirectory} over catalog's `activeBusinessActivityIds`. Any refusal or
 * fault is unavailable, never an empty set read as "none is active" by a caller that would then
 * accept. Bound by `SellerStoreProfileModule`; the facade opens a read-only unit of its own.
 */
export class CatalogBusinessActivityDirectory implements BusinessActivityDirectory {
  constructor(private readonly catalog: CatalogActivitiesFacade) {}

  async activeIds(
    context: CallContext,
    activityIds: readonly Id<'BusinessActivity'>[],
  ): Promise<Result<ReadonlySet<Id<'BusinessActivity'>>, BusinessActivityDirectoryUnavailable>> {
    try {
      const answer = await this.catalog.activeBusinessActivityIds(context, activityIds);
      return answer.ok ? ok(answer.value) : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }
}
