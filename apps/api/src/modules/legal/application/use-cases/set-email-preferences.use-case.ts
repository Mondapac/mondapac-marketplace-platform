import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { LegalDependencies } from '../legal-dependencies';
import {
  setEmailPreferences,
  type EmailPreferencesFailure,
  type EmailPreferencesInput,
  type EmailPreferencesView,
} from '../marketing-consent-flow';

/** `legal.set-email-preferences`: The customer gives or withdraws marketing email consent (rule `own-resources`). */
export class SetEmailPreferences extends UseCase<
  EmailPreferencesInput,
  EmailPreferencesView,
  EmailPreferencesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'legal.set-email-preferences',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: LegalDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: EmailPreferencesInput) {
    return setEmailPreferences(this.deps, context, input);
  }
}
