import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import {
  listCustomerAddresses,
  type CustomerAddressFailure,
  type CustomerAddressSummary,
} from '../customer-addresses-flow';
import type { CustomerManagementDependencies } from '../customer-management-dependencies';

/**
 * `customers.admin-customer-addresses`: a customer's delivery addresses for the customer page, as
 * suburb and country only (phase 2b). Rule: `customers.customers.view` and the admin population.
 */
export class AdminCustomerAddresses extends UseCase<
  unknown,
  { readonly items: readonly CustomerAddressSummary[] },
  CustomerAddressFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-addresses',
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
  ): Promise<
    Result<{ readonly items: readonly CustomerAddressSummary[] }, CustomerAddressFailure>
  > {
    return listCustomerAddresses(this.deps, context, input);
  }
}
