import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { AdminCustomerConsentHistory } from '../application/use-cases/admin-customer-consent-history.use-case';
import type { AdminCustomerConsent } from '../application/use-cases/admin-customer-consent.use-case';
import type {
  AdminConsentHistoryRequest,
  CustomerConsentFacade,
} from '../contracts/customer-consent.facade';

/** Passes the caller's `CallContext` unchanged to each use case, so the gate runs. */
export class CustomerConsentFacadeImplementation implements CustomerConsentFacade {
  constructor(
    private readonly consent: AdminCustomerConsent,
    private readonly history: AdminCustomerConsentHistory,
  ) {}

  adminCustomerConsent(context: CallContext, accountId: Id<'Account'>) {
    return this.consent.execute(context, { accountId });
  }

  adminCustomerConsentHistory(context: CallContext, request: AdminConsentHistoryRequest) {
    return this.history.execute(context, request);
  }
}
