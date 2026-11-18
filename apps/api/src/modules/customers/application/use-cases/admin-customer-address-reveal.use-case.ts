import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_ADDRESS_REVEAL, CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import {
  revealCustomerAddress,
  type CustomerAddressFailure,
  type CustomerAddressRevealView,
} from '../customer-addresses-flow';
import type { CustomerManagementDependencies } from '../customer-management-dependencies';

/**
 * `customers.admin-customer-address-reveal`: one of a customer's delivery addresses in full
 * (phase 2b). Audited (the address id) and on the customer's timeline before it is answered. Rule:
 * `customers.customers.view` and the protected `customers.customer-address.reveal`.
 */
export class AdminCustomerAddressReveal extends UseCase<
  unknown,
  CustomerAddressRevealView,
  CustomerAddressFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-address-reveal',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, CUSTOMERS_ADDRESS_REVEAL.key],
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
  ): Promise<Result<CustomerAddressRevealView, CustomerAddressFailure>> {
    return revealCustomerAddress(this.deps, context, input);
  }
}
