import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { SIGN_INS_SECTION } from '../customer-security-section';
import {
  readSectionList,
  type CustomerSectionDependencies,
  type CustomerSectionFailure,
} from '../customer-section-lists';
import { IDENTITY_CUSTOMER_SIGN_IN_VIEW } from '../section-keys';

/**
 * `customers.admin-customer-sign-ins`: a customer's sign-ins of the last 90 days as a super list
 * (time, result, outcome, device; never the address), from identity's facade (phase 2b). Rule:
 * `customers.customers.view` and identity's `identity.customer-sign-in.view`.
 */
export class AdminCustomerSignIns extends UseCase<unknown, unknown, CustomerSectionFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-sign-ins',
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
  ): Promise<Result<unknown, CustomerSectionFailure>> {
    return readSectionList(this.deps, SIGN_INS_SECTION, context, input);
  }
}
