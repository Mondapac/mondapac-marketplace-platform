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
import { CATALOG_BRAND_READ } from '../../contracts/permissions';
import type { CatalogWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `catalog.count-brand-merges` (dashboards upgrade, phase 1): The open brand merge groups (review queue). Overdue: detected before the age limit.
 * Rule: the key `catalog.brand.read`, platform admins only. One read-only unit.
 */
export class CountBrandMerges extends UseCase<WorkQueueCountQuery, WorkQueueCount, AccessDenied> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.count-brand-merges',
    rule: { kind: 'permissions', allOf: [CATALOG_BRAND_READ.key] },
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
      counts.brandMerges(context.market, query.now, query.staleBefore),
    );
  }
}
