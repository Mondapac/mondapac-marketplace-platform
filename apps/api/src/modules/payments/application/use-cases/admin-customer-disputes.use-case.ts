import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ListPage } from '../../../../platform/list-query';
import { PAYMENTS_CUSTOMER_PAYMENT_VIEW } from '../../contracts/permissions';
import {
  readCustomerDisputes,
  type CustomerDisputeView,
  type CustomerPaymentsDependencies,
  type CustomerPaymentsFailure,
} from '../customer-payments-flow';

/**
 * `payments.admin-customer-disputes`: the disputes of one customer's orders (state, reason,
 * amount, opened, evidence due by, outcome; no provider id) as a super list. Customers management
 * phase 2b. Rule: `payments.customer-payment.view`, a platform admin not acting as a seller.
 */
export class AdminCustomerDisputes extends UseCase<
  unknown,
  ListPage<CustomerDisputeView>,
  CustomerPaymentsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.admin-customer-disputes',
    rule: { kind: 'permissions', allOf: [PAYMENTS_CUSTOMER_PAYMENT_VIEW.key] },
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
  ): Promise<Result<ListPage<CustomerDisputeView>, CustomerPaymentsFailure>> {
    return readCustomerDisputes(this.deps, context, input);
  }
}
