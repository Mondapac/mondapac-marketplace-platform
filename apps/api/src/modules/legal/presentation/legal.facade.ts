import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { MarketingEmailConsentOf } from '../application/use-cases/marketing-email-consent-of.use-case';
import type { WithdrawMarketingEmailByLink } from '../application/use-cases/withdraw-marketing-email-by-link.use-case';
import type { LegalFacade } from '../contracts/legal.facade';

/** The use cases behind the facade, one per method. */
export interface LegalFacadeUseCases {
  readonly marketingEmailConsentOf: MarketingEmailConsentOf;
  readonly withdrawMarketingEmailByLink: WithdrawMarketingEmailByLink;
}

/**
 * The implementation of {@link LegalFacade}: each method passes the caller's `CallContext`
 * unchanged to one use case through `execute`, so the gate runs.
 */
export class LegalFacadeImplementation implements LegalFacade {
  constructor(private readonly useCases: LegalFacadeUseCases) {}

  marketingEmailConsentOf(context: CallContext, accountId: Id<'Account'>) {
    return this.useCases.marketingEmailConsentOf.execute(context, { accountId });
  }

  withdrawMarketingEmailByLink(context: CallContext, accountId: Id<'Account'>) {
    return this.useCases.withdrawMarketingEmailByLink.execute(context, { accountId });
  }
}
