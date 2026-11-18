import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_EXPORT, CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { SIGN_INS_SECTION } from '../customer-security-section';
import {
  exportSectionList,
  type CustomerSectionDependencies,
  type CustomerSectionFailure,
  type SectionExportFile,
} from '../customer-section-lists';
import { IDENTITY_CUSTOMER_SIGN_IN_VIEW } from '../section-keys';

/**
 * `customers.admin-customer-sign-ins-export`: a customer's sign-ins as a CSV or XLSX file (at most
 * 10,000; no address). Rule: `customers.customers.view`, `identity.customer-sign-in.view` and the
 * protected `customers.customers.export`, and a fresh step-up proof of it. Audited.
 */
export class AdminCustomerSignInsExport extends UseCase<
  unknown,
  SectionExportFile,
  CustomerSectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-sign-ins-export',
    rule: {
      kind: 'permissions',
      allOf: [
        CUSTOMERS_CUSTOMER_VIEW.key,
        IDENTITY_CUSTOMER_SIGN_IN_VIEW,
        CUSTOMERS_CUSTOMER_EXPORT.key,
      ],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerSectionDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<SectionExportFile, CustomerSectionFailure>> {
    return exportSectionList(this.deps, SIGN_INS_SECTION, context, input);
  }
}

/** The file every section export answers, for the controllers (they import use cases only). */
export type { SectionExportFile };
