import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import type { CustomerManagementDependencies } from '../customer-management-dependencies';
import { listGroups, type CustomerGroupView, type GroupFailure } from '../customer-groups-flow';

/**
 * `customers.admin-customer-groups-list`: every manual group of the Market with its member count,
 * live ones first (a simple list: a Market keeps at most 500). Rule: `customers.customers.view`
 * and the admin population.
 */
export class AdminCustomerGroupsList extends UseCase<
  unknown,
  { readonly items: readonly CustomerGroupView[] },
  GroupFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-groups-list',
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
  ): Promise<Result<{ readonly items: readonly CustomerGroupView[] }, GroupFailure>> {
    return listGroups(this.deps, context);
  }
}
