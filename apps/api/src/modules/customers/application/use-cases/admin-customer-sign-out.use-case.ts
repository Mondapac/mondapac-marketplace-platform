import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { signOutEverywhere, type CustomerSecurityFailure } from '../customer-security-section';
import type { CustomerSectionDependencies } from '../customer-section-lists';
import { IDENTITY_CUSTOMER_SESSION_END } from '../section-keys';

/**
 * `customers.admin-customer-sign-out`: "sign out everywhere" on the customer page (phase 2b).
 * identity ends every session and audits it; the timeline gets `signed-out-by-admin`. Rule:
 * `customers.customers.view` and `identity.customer-session.end`.
 */
export class AdminCustomerSignOut extends UseCase<
  unknown,
  { readonly revokedSessions: number },
  CustomerSecurityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-sign-out',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, IDENTITY_CUSTOMER_SESSION_END],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerSectionDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<{ readonly revokedSessions: number }, CustomerSecurityFailure>> {
    return signOutEverywhere(this.deps, context, input);
  }
}
