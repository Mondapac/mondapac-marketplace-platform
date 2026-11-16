import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_EXPORT, CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import type { CustomerManagementDependencies } from '../customer-management-dependencies';
import {
  exportTimeline,
  type TimelineExportOutput,
  type TimelineFailure,
} from '../customer-timeline-flow';

/**
 * `customers.admin-customer-timeline-export`: a customer's timeline as a CSV or XLSX file (at most
 * 10,000 entries). Rule: `customers.customers.view` and the protected `customers.customers.export`,
 * and a fresh two-step proof of `customers.customers.export` spent in the unit. Audited.
 */
export class AdminCustomerTimelineExport extends UseCase<
  unknown,
  TimelineExportOutput,
  TimelineFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-timeline-export',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, CUSTOMERS_CUSTOMER_EXPORT.key],
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
  ): Promise<Result<TimelineExportOutput, TimelineFailure>> {
    return exportTimeline(this.deps, context, input);
  }
}
