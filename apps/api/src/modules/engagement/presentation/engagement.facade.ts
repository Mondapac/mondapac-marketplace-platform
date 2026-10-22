import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { RecentViewsOfCustomer } from '../application/use-cases/recent-views.use-case';
import type { ForgetAccount } from '../application/use-cases/forget-account.use-case';
import type { RecentViewsOfGuest } from '../application/use-cases/recent-views-guest.use-case';
import type { EngagementFacade, RecentViewsRequest } from '../contracts/engagement.facade';

/** The use cases behind the facade, one per method. */
export interface EngagementFacadeUseCases {
  readonly forgetAccount: ForgetAccount;
  readonly recentViewsOfCustomer: RecentViewsOfCustomer;
  readonly recentViewsOfGuest: RecentViewsOfGuest;
}

/**
 * The implementation of {@link EngagementFacade}: each method passes the caller's `CallContext`
 * unchanged to one use case through `execute`, so the gate runs.
 */
export class EngagementFacadeImplementation implements EngagementFacade {
  constructor(private readonly useCases: EngagementFacadeUseCases) {}

  forgetAccount(context: CallContext, accountId: Id<'Account'>) {
    return this.useCases.forgetAccount.execute(context, { accountId });
  }

  recentViews(context: CallContext, request: RecentViewsRequest) {
    const useCase =
      context.actor.kind === 'authenticated'
        ? this.useCases.recentViewsOfCustomer
        : this.useCases.recentViewsOfGuest;
    return useCase.execute(context, request);
  }
}
