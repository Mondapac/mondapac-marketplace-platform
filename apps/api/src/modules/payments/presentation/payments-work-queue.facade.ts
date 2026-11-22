import type { CallContext } from '@mondapac/shared-kernel';
import type { WorkQueueCountQuery } from '../../../platform/work-queue/work-queue-count';
import type { CountFailedWebhooks } from '../application/use-cases/count-failed-webhooks.use-case';
import type { CountRestrictedAccounts } from '../application/use-cases/count-restricted-accounts.use-case';
import type { CountSellerPayoutsBlocked } from '../application/use-cases/count-seller-payouts-blocked.use-case';
import type { PaymentsWorkQueueFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to each use case, so the gate runs. */
export class PaymentsWorkQueueFacadeImplementation implements PaymentsWorkQueueFacade {
  constructor(
    private readonly failedWebhooksUseCase: CountFailedWebhooks,
    private readonly restrictedAccountsUseCase: CountRestrictedAccounts,
    private readonly sellerPayoutsBlockedUseCase: CountSellerPayoutsBlocked,
  ) {}

  failedWebhooks(context: CallContext, query: WorkQueueCountQuery) {
    return this.failedWebhooksUseCase.execute(context, query);
  }

  restrictedAccounts(context: CallContext, query: WorkQueueCountQuery) {
    return this.restrictedAccountsUseCase.execute(context, query);
  }

  sellerPayoutsBlocked(context: CallContext, query: WorkQueueCountQuery) {
    return this.sellerPayoutsBlockedUseCase.execute(context, query);
  }
}
