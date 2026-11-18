import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  AdminConsentState,
  CustomerConsentFailure,
} from '../../contracts/customer-consent.facade';
import { LEGAL_CUSTOMER_CONSENT_VIEW } from '../../contracts/permissions';
import { readAdminCustomerConsent } from '../admin-customer-consent';
import type { LegalDependencies } from '../legal-dependencies';

type Consent = { readonly channels: readonly AdminConsentState[] };

/**
 * `legal.admin-customer-consent`: one customer's current marketing consent per channel, for the
 * customer page (customers management phase 2b). Rule `permissions
 * [legal.customer-consent.view]`, a platform admin not acting as anyone. Facade only.
 */
export class AdminCustomerConsent extends UseCase<
  { readonly accountId: Id<'Account'> },
  Consent,
  CustomerConsentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'legal.admin-customer-consent',
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
    input: { readonly accountId: Id<'Account'> },
  ): Promise<Result<Consent, CustomerConsentFailure>> {
    return readAdminCustomerConsent(this.deps, context, input.accountId);
  }
}
