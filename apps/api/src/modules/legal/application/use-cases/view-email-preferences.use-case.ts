import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { LegalDependencies } from '../legal-dependencies';
import {
  viewEmailPreferences,
  type EmailPreferencesFailure,
  type EmailPreferencesView,
} from '../marketing-consent-flow';

export type { EmailPreferencesView };

/** `legal.view-email-preferences`: The customer reads their email preferences (rule `own-resources`). */
export class ViewEmailPreferences extends UseCase<
  Record<string, never>,
  EmailPreferencesView,
  EmailPreferencesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'legal.view-email-preferences',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: LegalDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewEmailPreferences(this.deps, context);
  }
}
