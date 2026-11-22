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
import { PAYMENTS_CUSTOMER_PAYMENT_VIEW } from '../../contracts/permissions';
import type { PaymentsWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `payments.count-failed-webhooks` (dashboards upgrade, phase 1): The Stripe events not applied: waiting since before the age limit (stuck or retrying), or given up within the last 7 days (today queue). Overdue: every one. Ids only.
 * Rule: the key `payments.customer-payment.view`, platform admins only. One read-only unit.
 */
export class CountFailedWebhooks extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.count-failed-webhooks',
    rule: { kind: 'permissions', allOf: [PAYMENTS_CUSTOMER_PAYMENT_VIEW.key] },
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
      counts.failedWebhooks(context.market, query.now, query.staleBefore),
    );
  }
}
