import type { CallContext, Id } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { LegalDependencies } from '../legal-dependencies';
import { marketingEmailConsentOf } from '../marketing-consent-flow';

/**
 * `legal.marketing-email-consent-of`: whether a marketing email may go to a customer account
 * (rule `system`; the marketing sends of notifications are jobs). Not exposed over HTTP.
 */
export class MarketingEmailConsentOf extends UseCase<
  { readonly accountId: Id<'Account'> },
  { readonly granted: boolean },
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'legal.marketing-email-consent-of',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: LegalDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly accountId: Id<'Account'> }) {
    return marketingEmailConsentOf(this.deps, context, input);
  }
}
