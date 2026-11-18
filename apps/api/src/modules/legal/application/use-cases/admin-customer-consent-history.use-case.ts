import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AdminConsentChange,
  AdminConsentHistoryRequest,
  CustomerConsentFailure,
} from '../../contracts/customer-consent.facade';
import { LEGAL_CUSTOMER_CONSENT_VIEW } from '../../contracts/permissions';
import { readAdminConsentHistory } from '../admin-customer-consent';
import type { LegalDependencies } from '../legal-dependencies';

type Page = { readonly rows: readonly AdminConsentChange[]; readonly total: number | null };

/**
 * `legal.admin-customer-consent-history`: one page of the changes of a customer's marketing
 * consent with their source, for the customer page (customers management phase 2b). Rule
 * `permissions [legal.customer-consent.view]`, a platform admin not acting as anyone. Facade only.
 */
export class AdminCustomerConsentHistory extends UseCase<
  AdminConsentHistoryRequest,
  Page,
  CustomerConsentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'legal.admin-customer-consent-history',
    rule: { kind: 'permissions', allOf: [LEGAL_CUSTOMER_CONSENT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: LegalDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: AdminConsentHistoryRequest,
  ): Promise<Result<Page, CustomerConsentFailure>> {
    return readAdminConsentHistory(this.deps, context, input);
  }
}
