import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ExportFile } from '../../../../platform/list-export';
import { PAYMENTS_CUSTOMER_PAYMENT_VIEW } from '../../contracts/permissions';
import {
  CUSTOMER_DATA_EXPORT_KEY,
  exportCustomerDisputes,
  type CustomerPaymentsDependencies,
  type CustomerPaymentsFailure,
} from '../customer-payments-flow';

/**
 * `payments.admin-customer-disputes-export`: the disputes of one customer's orders as a CSV or
 * XLSX file (at most 10,000). Rule: `payments.customer-payment.view` and the protected
 * `customers.customers.export`, and a fresh two-step proof of `customers.customers.export`. Audited.
 */
export class AdminCustomerDisputesExport extends UseCase<
  unknown,
  ExportFile,
  CustomerPaymentsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.admin-customer-disputes-export',
    rule: {
      kind: 'permissions',
      allOf: [PAYMENTS_CUSTOMER_PAYMENT_VIEW.key, CUSTOMER_DATA_EXPORT_KEY],
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
  ): Promise<Result<ExportFile, CustomerPaymentsFailure>> {
    return exportCustomerDisputes(this.deps, context, input);
  }
}
