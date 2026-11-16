import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ExportFile } from '../../../../platform/list-export';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import {
  CUSTOMER_DATA_EXPORT_KEY,
  exportCustomerRefunds,
  type CustomerRefundsExportDependencies,
  type CustomerRefundsFailure,
} from '../customer-refunds-list-flow';

/**
 * `ordering.admin-customer-refunds-export`: the refunds of one customer's orders as a CSV or XLSX
 * file (at most 10,000). Rule: `ordering.order.view` and the protected `customers.customers.export`
 * (customers' key: exporting a customer's data from the customer page), and a fresh two-step proof
 * of `customers.customers.export` spent in the unit. Audited (`ordering.customer-refunds.exported`).
 */
export class AdminCustomerRefundsExport extends UseCase<
  unknown,
  ExportFile,
  CustomerRefundsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-customer-refunds-export',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key, CUSTOMER_DATA_EXPORT_KEY] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerRefundsExportDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<ExportFile, CustomerRefundsFailure>> {
    return exportCustomerRefunds(this.deps, context, input);
  }
}
