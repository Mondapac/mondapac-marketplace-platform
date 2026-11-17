import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import { followStore, type FollowFailure, type FollowState } from '../store-follow-flow';

/** `engagement.follow-store`: the customer follows a published store (rule `own-resources`). */
export class FollowStore extends UseCase<
  { readonly sellerId?: unknown },
  FollowState,
  FollowFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.follow-store',
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
    return followStore(this.deps, context, input);
  }
}
