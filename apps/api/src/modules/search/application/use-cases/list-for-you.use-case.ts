import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { RecommendationDependencies } from '../recommendation-dependencies';
import {
  listForYou,
  type PersonalShelf,
  type PersonalShelfFailure,
  type PersonalShelfInput,
} from '../recommendation-flow';

export type { PersonalShelf, PersonalShelfFailure, PersonalShelfInput };

/**
 * `search.list-for-you`: A signed-in customer's "for you" shelf (personalization package 1d-1). Rule `own-resources`: the context's customer is the subject of the views.
 * Never logs or returns the token or an id of the shopper.
 */
export class ListForYou extends UseCase<PersonalShelfInput, PersonalShelf, PersonalShelfFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'search.list-for-you',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RecommendationDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: PersonalShelfInput,
  ): Promise<Result<PersonalShelf, PersonalShelfFailure>> {
    return listForYou(this.deps, context, input);
  }
}
