import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { ServedPlacements } from '../application/ports/served-placements';
import type { StorefrontFacade } from '../../storefront';

/**
 * {@link ServedPlacements} on storefront's public facade. The caller's `CallContext` goes through
 * unchanged. A refusal counts as "nothing is served", so nothing is counted.
 */
export class FacadeServedPlacements implements ServedPlacements {
  constructor(private readonly storefront: StorefrontFacade) {}

  async of(context: CallContext, pageId: Id<'StorefrontPage'>): Promise<ReadonlySet<string>> {
    const answer = await this.storefront.servedPlacements(context, pageId);
    return answer.ok ? answer.value : new Set();
  }
}
