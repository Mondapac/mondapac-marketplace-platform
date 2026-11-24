import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import {
  countAdminWorkQueue,
  type WorkQueueCountDependencies,
} from '../../../../platform/work-queue/count-work-queue';
import { CATALOG_PRODUCT_VIEW } from '../../../catalog';
import type { LiveListingCounter, LiveListingCounts } from '../ports/live-listing-counter';

/**
 * `search.count-live-listings` (dashboards v2, phase 1, PR 6): the Market's live listings (the
 * Offers a shopper can find: published, listed, the seller may sell) and how many of them have no
 * sell unit in stock, for the admin dashboard's supply and health card. Counts only: no Offer,
 * seller or product id leaves the module. Rule: the catalog key `catalog.product.view` (the same
 * key as the card's other listing count), platform admins acting as themselves only. One read-only
 * unit.
 */
export class CountLiveListings extends UseCase<
  { readonly signal: AbortSignal },
  LiveListingCounts,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'search.count-live-listings',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WorkQueueCountDependencies<LiveListingCounter>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    query: { readonly signal: AbortSignal },
  ): Promise<Result<LiveListingCounts, AccessDenied>> {
    return countAdminWorkQueue(this.deps, context, query, (counts) =>
      counts.liveListings(context.market),
    );
  }
}
