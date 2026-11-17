import type { CallContext, Id } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import { followedAmong, type FollowFailure } from '../store-follow-flow';

/** `engagement.followed-among`: which of some sellers an account follows (the quote of the store-follower offer) (rule `system`). */
export class FollowedAmong extends UseCase<
  { readonly accountId: Id<'Account'>; readonly sellerIds: readonly Id<'Seller'>[] },
  readonly Id<'Seller'>[],
  FollowFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.followed-among',
    rule: { kind: 'system' },
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
