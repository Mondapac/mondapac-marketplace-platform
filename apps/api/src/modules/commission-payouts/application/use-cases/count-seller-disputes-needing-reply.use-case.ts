import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import {
  countSellerWorkQueue,
  type WorkQueueCountDependencies,
} from '../../../../platform/work-queue/count-work-queue';
import type {
  WorkQueueCount,
  WorkQueueCountQuery,
} from '../../../../platform/work-queue/work-queue-count';
import { COMMISSION_PAYOUTS_EARNINGS_VIEW } from '../../contracts/permissions';
import type { CommissionPayoutsWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `commission-payouts.count-seller-disputes-needing-reply` (dashboards upgrade, phase 1, seller tasks): the disputes on the seller's own orders that need a response (the `needs-response` bucket). Overdue: the response deadline has passed; the oldest is the nearest deadline.
 * Rule: the key `commission-payouts.earnings.view` (the module's one seller read key: the money
 * the seller is owed), the session's own seller only, allowed while the seller is not approved (a
 * suspended seller still sees what holds its money, as its dispute and hold lists). One read-only
 * unit.
 */
export class CountSellerDisputesNeedingReply extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.count-seller-disputes-needing-reply',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_EARNINGS_VIEW.key] },
    whenSellerNotApproved: 'allow',
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
    return countSellerWorkQueue(this.deps, context, query, (counts, sellerId) =>
      counts.sellerDisputesNeedingReply(context.market, sellerId, query.now),
    );
  }
}
