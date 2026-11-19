import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { sendPasswordReset, type CustomerSecurityFailure } from '../customer-security-section';
import type { CustomerSectionDependencies } from '../customer-section-lists';
import { IDENTITY_CUSTOMER_PASSWORD_RESET_SEND } from '../section-keys';

/**
 * `customers.admin-customer-password-reset`: "send password reset" on the customer page (phase 2b).
 * identity requests the reset mail to the customer's own verified address and audits it; the
 * timeline gets `password-reset-sent`. Rule: `customers.customers.view` and
 * `identity.customer-password-reset.send`.
 */
export class AdminCustomerPasswordReset extends UseCase<
  unknown,
  { readonly sent: true },
  CustomerSecurityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-password-reset',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, IDENTITY_CUSTOMER_PASSWORD_RESET_SEND],
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
  ): Promise<Result<{ readonly sent: true }, CustomerSecurityFailure>> {
    return sendPasswordReset(this.deps, context, input);
  }
}
