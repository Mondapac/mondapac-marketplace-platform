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
  DisputesOpened,
  DisputesOpenedQuery,
} from '../../contracts/commission-payouts-work-queue.facade';
import { COMMISSION_PAYOUTS_DISPUTE_VIEW } from '../../contracts/permissions';
import type { CommissionPayoutsWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `commission-payouts.count-disputes-opened` (dashboards v2, phase 1, PR 6): how many chargebacks
 * were opened in a window (Stripe inquiries left out), the numerator of the admin dashboard's
 * dispute rate. A count only: no case, order, amount or reason leaves the module. Rule: the key
 * `commission-payouts.dispute.view`, platform admins acting as themselves only. One read-only unit.
 */
export class CountDisputesOpened extends UseCase<
  DisputesOpenedQuery,
  DisputesOpened,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.count-disputes-opened',
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
    query: DisputesOpenedQuery,
  ): Promise<Result<DisputesOpened, AccessDenied>> {
    return countAdminWorkQueue(this.deps, context, query, async (counts) => ({
      count: await counts.disputesOpened(context.market, query.from, query.to),
    }));
  }
}
