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
import { COMMISSION_PAYOUTS_PAYOUT_VIEW } from '../../contracts/permissions';
import type { CommissionPayoutsWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `commission-payouts.count-failed-payouts` (dashboards upgrade, phase 1): The payouts that failed within the last 7 days (today queue). Overdue: failed before the age limit.
 * Rule: the key `commission-payouts.payout.view`, platform admins only. One read-only unit.
 */
export class CountFailedPayouts extends UseCase<WorkQueueCountQuery, WorkQueueCount, AccessDenied> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.count-failed-payouts',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_PAYOUT_VIEW.key] },
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
      counts.failedPayouts(context.market, query.now, query.staleBefore),
    );
  }
}
