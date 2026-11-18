import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { consentAnswer } from '../customer-activity-sections';
import {
  readSectionItem,
  type CustomerSectionDependencies,
  type CustomerSectionFailure,
} from '../customer-section-lists';
import { LEGAL_CUSTOMER_CONSENT_VIEW } from '../section-keys';

/**
 * `customers.admin-customer-consent`: a customer's current marketing consent per channel with its source, from legal's facade (phase 2b). Read only. Rule: `customers.customers.view` and `legal.customer-consent.view`.
 */
export class AdminCustomerConsentSection extends UseCase<unknown, unknown, CustomerSectionFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-consent',
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
    return readSectionItem(
      this.deps,
      context,
      input,
      (peers, accountId) => peers.consent.adminCustomerConsent(context, accountId),
      consentAnswer,
    );
  }
}
