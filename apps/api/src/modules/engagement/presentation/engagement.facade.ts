import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { ForgetAccount } from '../application/use-cases/forget-account.use-case';
import type { EngagementFacade } from '../contracts/engagement.facade';

/** The use cases behind the facade, one per method. */
export interface EngagementFacadeUseCases {
  readonly forgetAccount: ForgetAccount;
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
}
