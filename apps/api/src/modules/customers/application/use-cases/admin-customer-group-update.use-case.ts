import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW, CUSTOMERS_GROUPS_MANAGE } from '../../contracts/permissions';
import type { CustomerManagementDependencies } from '../customer-management-dependencies';
import { updateGroup, type CustomerGroupView, type GroupFailure } from '../customer-groups-flow';

/**
 * `customers.admin-customer-group-update`: renames, describes, archives or restores a group under
 * the version the admin saw. Audited. Rule: `customers.customers.view` and `customers.groups.manage`.
 */
export class AdminCustomerGroupUpdate extends UseCase<unknown, CustomerGroupView, GroupFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-group-update',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, CUSTOMERS_GROUPS_MANAGE.key],
    },
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
    return updateGroup(this.deps, context, input);
  }
}
