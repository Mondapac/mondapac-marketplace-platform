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
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import type { SellersWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `sellers.count-seller-applications` (dashboards upgrade, phase 1): The seller files waiting for review, the "Awaiting review" tab (today queue). Overdue: submitted before the age limit.
 * Rule: the key `sellers.seller.view`, platform admins only. One read-only unit.
 */
export class CountSellerApplications extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.count-seller-applications',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WorkQueueCountDependencies<SellersWorkQueueCountReader>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>> {
    return countAdminWorkQueue(this.deps, context, query, (counts) =>
      counts.applications(context.market, query.now, query.staleBefore),
    );
  }
}
