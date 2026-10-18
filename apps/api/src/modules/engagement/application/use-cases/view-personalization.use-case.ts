import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import {
  viewPersonalization,
  type PersonalizationFailure,
  type PersonalizationView,
} from '../engagement-flow';

export type { PersonalizationView };

/** `engagement.view-personalization`: the customer reads their personalization switch (rule `own-resources`). */
export class ViewPersonalization extends UseCase<
  Record<string, never>,
  PersonalizationView,
  PersonalizationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.view-personalization',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EngagementDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewPersonalization(this.deps, context);
  }
}
