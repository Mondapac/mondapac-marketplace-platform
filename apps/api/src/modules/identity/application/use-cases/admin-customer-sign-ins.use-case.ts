import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMER_SIGN_IN_VIEW } from '../../contracts/permissions';
import {
  readCustomerSignIns,
  type CustomerSecurityDependencies,
  type CustomerSecurityFailure,
  type CustomerSignInsPage,
  type CustomerSignInsRequest,
} from '../accounts/customer-security';

/**
 * `identity.admin-customer-sign-ins`: one page of a customer's sign-ins of the last 90 days (time,
 * outcome, result, device; never the address) for the customer page (customers management phase
 * 2b), which `customers` pages and exports. Rule `permissions [identity.customer-sign-in.view]`,
 * and a platform admin that is not acting as anyone, checked again here. Facade only.
 */
export class AdminCustomerSignIns extends UseCase<
  CustomerSignInsRequest,
  CustomerSignInsPage,
  CustomerSecurityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.admin-customer-sign-ins',
    rule: { kind: 'permissions', allOf: [CUSTOMER_SIGN_IN_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerSecurityDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: CustomerSignInsRequest,
  ): Promise<Result<CustomerSignInsPage, CustomerSecurityFailure>> {
    return readCustomerSignIns(this.deps, context, input);
  }
}
