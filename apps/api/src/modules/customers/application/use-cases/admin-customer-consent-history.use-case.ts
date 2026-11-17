import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { CONSENT_HISTORY_SECTION } from '../customer-activity-sections';
import {
  readSectionList,
  type CustomerSectionDependencies,
  type CustomerSectionFailure,
} from '../customer-section-lists';
import { LEGAL_CUSTOMER_CONSENT_VIEW } from '../section-keys';

/**
 * `customers.admin-customer-consent-history`: the changes of a customer's marketing consent with their source as a super list, from legal's facade (phase 2b). Rule: `customers.customers.view` and `legal.customer-consent.view`.
 */
export class AdminCustomerConsentHistorySection extends UseCase<
  unknown,
  unknown,
  CustomerSectionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-consent-history',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, LEGAL_CUSTOMER_CONSENT_VIEW],
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
  ): Promise<Result<unknown, CustomerSectionFailure>> {
    return readSectionList(this.deps, CONSENT_HISTORY_SECTION, context, input);
  }
}
