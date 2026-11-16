import type { CallContext, Id } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import { followedAmong, type FollowFailure } from '../store-follow-flow';

/** `engagement.own-followed-among`: which of some sellers the calling customer follows (their own cart's quote) (rule `own-resources`). */
export class OwnFollowedAmong extends UseCase<
  { readonly accountId: Id<'Account'>; readonly sellerIds: readonly Id<'Seller'>[] },
  readonly Id<'Seller'>[],
  FollowFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.own-followed-among',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EngagementDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly accountId: Id<'Account'>; readonly sellerIds: readonly Id<'Seller'>[] },
  ) {
    return followedAmong(this.deps, context, input);
  }
}
