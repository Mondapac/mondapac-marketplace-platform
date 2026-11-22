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
import { COMMISSION_PAYOUTS_DISPUTE_VIEW } from '../../contracts/permissions';
import type { CommissionPayoutsWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `commission-payouts.count-disputes-due` (dashboards upgrade, phase 1): The disputes that need a response within 24 hours or are past their deadline (critical queue, live). Overdue: past the deadline.
 * Rule: the key `commission-payouts.dispute.view`, platform admins only. One read-only unit.
 */
export class CountDisputesDue extends UseCase<WorkQueueCountQuery, WorkQueueCount, AccessDenied> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.count-disputes-due',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_DISPUTE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WorkQueueCountDependencies<CommissionPayoutsWorkQueueCountReader>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>> {
    return countAdminWorkQueue(this.deps, context, query, (counts) =>
      counts.disputesDue(context.market, query.now),
    );
  }
}
