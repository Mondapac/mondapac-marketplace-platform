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
import { PAYMENTS_PAYOUT_ACCOUNT_VIEW } from '../../contracts/permissions';
import type { PaymentsWorkQueueCountReader } from '../ports/work-queue-count.reader';

/**
 * `payments.count-seller-payouts-blocked` (dashboards upgrade, phase 1, seller tasks): 1 when the
 * seller's own payout account is restricted or its payouts are not enabled, else 0. Rule: the key
 * `payments.payout-account.view`, the session's own seller only, allowed while the seller is not
 * approved (as the payout account page, which shows "not connected"). One read-only unit; the
 * stored row only, no call to Stripe.
 */
export class CountSellerPayoutsBlocked extends UseCase<
  WorkQueueCountQuery,
  WorkQueueCount,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.count-seller-payouts-blocked',
    rule: { kind: 'permissions', allOf: [PAYMENTS_PAYOUT_ACCOUNT_VIEW.key] },
    whenSellerNotApproved: 'allow',
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
    return countSellerWorkQueue(this.deps, context, query, (counts, sellerId) =>
      counts.sellerPayoutsBlocked(context.market, sellerId),
    );
  }
}
