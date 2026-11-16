import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PAYMENTS_CUSTOMER_PAYMENT_VIEW } from '../../contracts/permissions';
import {
  CUSTOMER_DATA_VIEW_KEY,
  readCustomerPayments,
  type CustomerPaymentsListPage,
  type CustomerPaymentsDependencies,
  type CustomerPaymentsFailure,
} from '../customer-payments-flow';

/**
 * `payments.admin-customer-payments`: one customer's payments (per order: state, payment state,
 * amount, Stripe's payment id, created) as a super list, with the captured total ("Paid").
 * Customers management phase 2b. Rule: `payments.customer-payment.view` and
 * `customers.customers.view`, a platform admin not acting as a seller; ordering's facade read
 * declares the same key.
 */
export class AdminCustomerPayments extends UseCase<
  unknown,
  CustomerPaymentsListPage,
  CustomerPaymentsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.admin-customer-payments',
    rule: {
      kind: 'permissions',
      allOf: [PAYMENTS_CUSTOMER_PAYMENT_VIEW.key, CUSTOMER_DATA_VIEW_KEY],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerPaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<CustomerPaymentsListPage, CustomerPaymentsFailure>> {
    return readCustomerPayments(this.deps, context, input);
  }
}
