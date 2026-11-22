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
 * `catalog.count-pending-revisions` (dashboards upgrade, phase 1): The sellers' product revisions waiting for review (today queue). Overdue: submitted before the age limit.
 * Rule: the key `catalog.product.view`, platform admins only. One read-only unit.
 */
export class CountPendingRevisions extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.count-pending-revisions',
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
      counts.pendingRevisions(context.market, query.now, query.staleBefore),
    );
  }
}
