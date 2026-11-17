import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import { unfollowStore, type FollowFailure, type FollowState } from '../store-follow-flow';

/** `engagement.unfollow-store`: the customer stops following a store (rule `own-resources`). */
export class UnfollowStore extends UseCase<
  { readonly sellerId?: unknown },
  FollowState,
  FollowFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.unfollow-store',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EngagementDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerId?: unknown }) {
    return unfollowStore(this.deps, context, input);
  }
}
