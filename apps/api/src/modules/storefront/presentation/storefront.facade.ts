import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { ViewServedPlacements } from '../application/use-cases/view-served-placements.use-case';
import type { StorefrontFacade } from '../contracts/storefront.facade';

/**
 * The implementation of {@link StorefrontFacade}: each method passes the caller's `CallContext`
 * unchanged to one use case through `execute`, so the gate runs.
 */
export class StorefrontFacadeImplementation implements StorefrontFacade {
  constructor(private readonly servedPlacementsOf: ViewServedPlacements) {}

  servedPlacements(context: CallContext, pageId: Id<'StorefrontPage'>) {
    return this.servedPlacementsOf.execute(context, { pageId });
  }
}
