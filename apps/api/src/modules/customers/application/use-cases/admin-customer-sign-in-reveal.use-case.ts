import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { revealSignInAddress, type CustomerSecurityFailure } from '../customer-security-section';
import type { CustomerSectionDependencies } from '../customer-section-lists';
import { IDENTITY_CUSTOMER_SIGN_IN_REVEAL, IDENTITY_CUSTOMER_SIGN_IN_VIEW } from '../section-keys';

/**
 * `customers.admin-customer-sign-in-reveal`: the full client address of one of a customer's
 * sign-ins (phase 2b). identity audits it in the unit that reads it; the timeline entry
 * `sign-in-address-revealed` is written before it is answered. Rule: `customers.customers.view`,
 * `identity.customer-sign-in.view` and the protected `identity.customer-sign-in.reveal`.
 */
export class AdminCustomerSignInReveal extends UseCase<
  unknown,
  { readonly signInId: string; readonly address: string; readonly occurredAt: string },
  CustomerSecurityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-sign-in-reveal',
    rule: {
      kind: 'permissions',
      allOf: [
        CUSTOMERS_CUSTOMER_VIEW.key,
        IDENTITY_CUSTOMER_SIGN_IN_VIEW,
        IDENTITY_CUSTOMER_SIGN_IN_REVEAL,
      ],
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
  ): Promise<
    Result<
      { readonly signInId: string; readonly address: string; readonly occurredAt: string },
      CustomerSecurityFailure
    >
  > {
    return revealSignInAddress(this.deps, context, input);
  }
}
