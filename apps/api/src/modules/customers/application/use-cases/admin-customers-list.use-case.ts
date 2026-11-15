import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import {
  adminAccountOf,
  listCustomers,
  parseListRequest,
  type CustomerListDependencies,
  type CustomerListOutput,
  type ListValidationFailure,
} from '../customer-list-flow';

export type AdminCustomersListFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | ListValidationFailure;

/**
 * `customers.admin-customers-list`: the Market's customers, a super list. A tab (`view`: all, new
 * in 30 days, active with an order in 90 days, inactive, never ordered, disabled, pending
 * deletion), a search (`q`: sign-in address prefix or a part of the display name), filters (status,
 * email verified, joined and last order dates, order count, amount spent), a sort and a page: with
 * `page` (and `pageSize`) the answer carries the total (the page-number mode of the List paging
 * setting, at most 10,000 rows deep), without it a `cursor` and `limit` read the next page without
 * a total. The answer also carries the size of every tab. Rule: the key `customers.customers.view`
 * and the admin population. The rows are personal data and are never logged.
 */
export class AdminCustomersList extends UseCase<
  unknown,
  CustomerListOutput,
  AdminCustomersListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customers-list',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_CUSTOMER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<CustomerListOutput, AdminCustomersListFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const request = parseListRequest(input);
    if (!request.ok) return request;
    return listCustomers(this.deps, context, request.value);
  }
}
