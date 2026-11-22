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
 * `ordering.count-late-deliveries` (dashboards upgrade, phase 1): The paid seller orders past their delivery promise (critical queue; the promise per delivery method is documented on the reader). Overdue: past it by more than the queue's age limit.
 * Rule: the key `ordering.order.view`, platform admins only. One read-only unit.
 */
export class CountLateDeliveries extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.count-late-deliveries',
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
      counts.lateDeliveries(context.market, query.now, query.staleBefore, query.signal),
    );
  }
}
