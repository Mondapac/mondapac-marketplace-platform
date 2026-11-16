import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW, CUSTOMERS_GROUPS_MANAGE } from '../../contracts/permissions';
import type { CustomerManagementDependencies } from '../customer-management-dependencies';
import {
  changeMembers,
  type GroupFailure,
  type MembersChangeOutput,
} from '../customer-groups-flow';

/**
 * `customers.admin-customer-group-members-add`: adds customers to a live group, by ids or by the
 * Customers list's filter ("select all matching"). Audited; a timeline entry per customer added.
 * Rule: `customers.customers.view` and `customers.groups.manage`.
 */
export class AdminCustomerGroupMembersAdd extends UseCase<
  unknown,
  MembersChangeOutput,
  GroupFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-group-members-add',
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
  ): Promise<Result<MembersChangeOutput, GroupFailure>> {
    return changeMembers(this.deps, context, 'add', input);
  }
}
