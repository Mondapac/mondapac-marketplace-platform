import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { readSessions, type CustomerSecurityFailure } from '../customer-security-section';
import type { CustomerSectionDependencies } from '../customer-section-lists';
import { IDENTITY_CUSTOMER_SIGN_IN_VIEW } from '../section-keys';

/**
 * `customers.admin-customer-sessions`: a customer's live sessions (device, signed in, last active),
 * at most 50, from identity (phase 2b). Rule: `customers.customers.view` and
 * `identity.customer-sign-in.view`.
 */
export class AdminCustomerSessions extends UseCase<unknown, unknown, CustomerSecurityFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-sessions',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, IDENTITY_CUSTOMER_SIGN_IN_VIEW],
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
  ): Promise<Result<unknown, CustomerSecurityFailure>> {
    return readSessions(this.deps, context, input);
  }
}
