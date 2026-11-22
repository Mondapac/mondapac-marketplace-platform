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
import { PAYMENTS_CONNECTED_ACCOUNT_VIEW } from '../../contracts/permissions';
import type { PaymentsWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `payments.count-restricted-accounts` (dashboards upgrade, phase 1): The sellers' connected accounts Stripe restricted (today queue). Overdue: restricted since before the age limit.
 * Rule: the key `payments.connected-account.view`, platform admins only. One read-only unit.
 */
export class CountRestrictedAccounts extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.count-restricted-accounts',
    rule: { kind: 'permissions', allOf: [PAYMENTS_CONNECTED_ACCOUNT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WorkQueueCountDependencies<PaymentsWorkQueueCountReader>,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    query: WorkQueueCountQuery,
  ): Promise<Result<WorkQueueCount, AccessDenied>> {
    return countAdminWorkQueue(this.deps, context, query, (counts) =>
      counts.restrictedAccounts(context.market, query.now, query.staleBefore),
    );
  }
}
