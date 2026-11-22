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
import { CATALOG_CATEGORY_PROPOSAL_DECIDE } from '../../contracts/permissions';
import type { CatalogWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `catalog.count-category-proposals` (dashboards upgrade, phase 1): The sellers' category proposals waiting for a decision (review queue). Overdue: proposed before the age limit.
 * Rule: the key `catalog.category-proposal.decide`, platform admins only. One read-only unit.
 */
export class CountCategoryProposals extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.count-category-proposals',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_PROPOSAL_DECIDE.key] },
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
      counts.categoryProposals(context.market, query.now, query.staleBefore),
    );
  }
}
