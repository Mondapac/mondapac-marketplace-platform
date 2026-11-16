import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ExportFile } from '../../../../platform/list-export';
import { PAYMENTS_CUSTOMER_PAYMENT_VIEW } from '../../contracts/permissions';
import {
  CUSTOMER_DATA_EXPORT_KEY,
  CUSTOMER_DATA_VIEW_KEY,
  exportCustomerPayments,
  type CustomerPaymentsDependencies,
  type CustomerPaymentsFailure,
} from '../customer-payments-flow';

/**
 * `payments.admin-customer-payments-export`: one customer's payments as a CSV or XLSX file (at most
 * 10,000). Rule: `payments.customer-payment.view`, `customers.customers.view` and the protected
 * `customers.customers.export`, and a fresh two-step proof of `customers.customers.export`.
 * Audited.
 */
export class AdminCustomerPaymentsExport extends UseCase<
  unknown,
  ExportFile,
  CustomerPaymentsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.admin-customer-payments-export',
    rule: {
      kind: 'permissions',
      allOf: [PAYMENTS_CUSTOMER_PAYMENT_VIEW.key, CUSTOMER_DATA_VIEW_KEY, CUSTOMER_DATA_EXPORT_KEY],
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
    return exportCustomerPayments(this.deps, context, input);
  }
}
