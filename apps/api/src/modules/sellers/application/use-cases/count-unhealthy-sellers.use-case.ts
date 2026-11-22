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
 * `sellers.count-unhealthy-sellers` (dashboards upgrade, phase 1): The sellers of the health queue ("Needs a look"; today queue). A snapshot, not a wait: no overdue and no oldest.
 * Rule: the key `sellers.seller.view`, platform admins only. One read-only unit.
 */
export class CountUnhealthySellers extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.count-unhealthy-sellers',
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
      counts.unhealthySellers(context.market, query.now, query.staleBefore),
    );
  }
}
