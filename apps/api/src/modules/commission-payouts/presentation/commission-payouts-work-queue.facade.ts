import type { CallContext } from '@mondapac/shared-kernel';
import type { WorkQueueCountQuery } from '../../../platform/work-queue/work-queue-count';
import type { CountFailedPayouts } from '../application/use-cases/count-failed-payouts.use-case';
import type { CountPayoutHolds } from '../application/use-cases/count-payout-holds.use-case';
import type { CountDisputesDue } from '../application/use-cases/count-disputes-due.use-case';
import type { CountSellerDisputesNeedingReply } from '../application/use-cases/count-seller-disputes-needing-reply.use-case';
import type { CountSellerPayoutHolds } from '../application/use-cases/count-seller-payout-holds.use-case';
import type { CountDisputesOpened } from '../application/use-cases/count-disputes-opened.use-case';
import type { CommissionPayoutsWorkQueueFacade, DisputesOpenedQuery } from '../contracts';

/** Passes the caller's `CallContext` unchanged to each use case, so the gate runs. */
export class CommissionPayoutsWorkQueueFacadeImplementation implements CommissionPayoutsWorkQueueFacade {
  constructor(
    private readonly failedPayoutsUseCase: CountFailedPayouts,
    private readonly payoutHoldsUseCase: CountPayoutHolds,
    private readonly disputesDueUseCase: CountDisputesDue,
    private readonly sellerDisputesUseCase: CountSellerDisputesNeedingReply,
    private readonly sellerHoldsUseCase: CountSellerPayoutHolds,
    private readonly disputesOpenedUseCase: CountDisputesOpened,
  ) {}

  disputesOpened(context: CallContext, query: DisputesOpenedQuery) {
    return this.disputesOpenedUseCase.execute(context, query);
  }

  failedPayouts(context: CallContext, query: WorkQueueCountQuery) {
    return this.failedPayoutsUseCase.execute(context, query);
  }

  payoutHolds(context: CallContext, query: WorkQueueCountQuery) {
    return this.payoutHoldsUseCase.execute(context, query);
  }

  disputesDue(context: CallContext, query: WorkQueueCountQuery) {
    return this.disputesDueUseCase.execute(context, query);
  }

  sellerDisputesNeedingReply(context: CallContext, query: WorkQueueCountQuery) {
    return this.sellerDisputesUseCase.execute(context, query);
  }

  sellerPayoutHolds(context: CallContext, query: WorkQueueCountQuery) {
    return this.sellerHoldsUseCase.execute(context, query);
  }
}
