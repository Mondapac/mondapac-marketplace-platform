import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import type { CustomerManagementDependencies } from '../customer-management-dependencies';
import { viewGroup, type CustomerGroupView, type GroupFailure } from '../customer-groups-flow';

/**
 * `customers.admin-customer-group-view`: one group, for the header of its members page (the members
 * are the Customers list with `filters.group`). Rule: `customers.customers.view`.
 */
export class AdminCustomerGroupView extends UseCase<unknown, CustomerGroupView, GroupFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-group-view',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_CUSTOMER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerManagementDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<CustomerGroupView, GroupFailure>> {
    return viewGroup(this.deps, context, input);
  }
}
