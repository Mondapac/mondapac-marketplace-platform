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
import { SECURITY_VIEW } from '../../contracts/permissions';
import type { SecurityWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `security.count-open-security-alerts` (dashboards upgrade, phase 1): The live security alerts, open or acknowledged (critical queue, live). Overdue: opened before the age limit.
 * Rule: the key `security.centre.view`, platform admins only. One read-only unit.
 */
export class CountOpenSecurityAlerts extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'security.count-open-security-alerts',
    rule: { kind: 'permissions', allOf: [SECURITY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WorkQueueCountDependencies<SecurityWorkQueueCountReader>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>> {
    return countAdminWorkQueue(this.deps, context, query, (counts) =>
      counts.openAlerts(context.market, query.now, query.staleBefore),
    );
  }
}
