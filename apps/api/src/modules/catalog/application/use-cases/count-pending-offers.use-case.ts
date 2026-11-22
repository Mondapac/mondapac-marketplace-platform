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
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../../platform/work-queue/work-queue-count';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import type { CatalogWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `catalog.count-pending-offers` (dashboards upgrade, phase 1): The Offers waiting for their first-publication review (today queue). Overdue: submitted before the age limit.
 * Rule: the key `catalog.product.view`, platform admins only. One read-only unit.
 */
export class CountPendingOffers extends UseCase<WorkQueueCountQuery, WorkQueueCount, AccessDenied> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.count-pending-offers',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WorkQueueCountDependencies<CatalogWorkQueueCountReader>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>> {
    return countAdminWorkQueue(this.deps, context, query, (counts) =>
      counts.pendingOffers(context.market, query.now, query.staleBefore),
    );
  }
}
