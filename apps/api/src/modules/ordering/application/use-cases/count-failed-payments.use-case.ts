import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../../platform/work-queue/work-queue-count';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import {
  countAdminWorkQueue,
  type WorkQueueCountDependencies,
} from '../../../../platform/work-queue/count-work-queue';
import type { WorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `ordering.count-failed-payments` (dashboards upgrade, phase 1): The orders whose payment failed (`payment-failed`,
 * `provider-failed`) within the last 24 hours (today queue). Overdue: cancelled before the age limit.
 * Rule: the key `ordering.order.view`, platform admins only. One read-only unit.
 */
export class CountFailedPayments extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.count-failed-payments',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WorkQueueCountDependencies<WorkQueueCountReader>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>> {
    return countAdminWorkQueue(this.deps, context, query, (counts) =>
      counts.failedPayments(context.market, query.now, query.staleBefore),
    );
  }
}
