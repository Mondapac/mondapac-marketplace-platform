import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { RecommendationDependencies } from '../recommendation-dependencies';
import {
  listRecentlyViewed,
  type PersonalShelf,
  type PersonalShelfFailure,
  type PersonalShelfInput,
} from '../recommendation-flow';

/**
 * `search.list-recently-viewed`: A signed-in customer's "recently viewed" shelf (personalization package 1d-1). Rule `own-resources`: the context's customer is the subject of the views.
 * Never logs or returns the token or an id of the shopper.
 */
export class ListRecentlyViewed extends UseCase<
  PersonalShelfInput,
  PersonalShelf,
  PersonalShelfFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'search.list-recently-viewed',
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
    return listRecentlyViewed(this.deps, context, input);
  }
}
