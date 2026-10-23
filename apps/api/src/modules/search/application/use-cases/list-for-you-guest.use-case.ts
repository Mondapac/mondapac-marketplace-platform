import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { RecommendationDependencies } from '../recommendation-dependencies';
import {
  listForYou,
  type PersonalShelf,
  type PersonalShelfFailure,
  type PersonalShelfInput,
} from '../recommendation-flow';

/**
 * `search.list-for-you-guest`: A guest's "for you" shelf (personalization package 1d-1). Rule `anonymous`: no session; the subject is the engagement guest cookie's token, which engagement hashes.
 * Never logs or returns the token or an id of the shopper.
 */
export class ListForYouGuest extends UseCase<
  PersonalShelfInput,
  PersonalShelf,
  PersonalShelfFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'search.list-for-you-guest',
    rule: { kind: 'anonymous' },
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
