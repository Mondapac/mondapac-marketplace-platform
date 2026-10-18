import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import {
  setPersonalization,
  type PersonalizationFailure,
  type PersonalizationView,
} from '../engagement-flow';

/**
 * `engagement.set-personalization`: the customer switches personalization on or off; off deletes
 * their recorded behaviour (rule `own-resources`).
 */
export class SetPersonalization extends UseCase<
  Readonly<Record<string, unknown>>,
  PersonalizationView,
  PersonalizationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.set-personalization',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EngagementDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Readonly<Record<string, unknown>>) {
    return setPersonalization(this.deps, context, input);
  }
}
