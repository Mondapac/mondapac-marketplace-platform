import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import { viewFollow, type FollowFailure, type FollowState } from '../store-follow-flow';

/** `engagement.view-store-follow`: whether the customer follows one store (rule `own-resources`). */
export class ViewStoreFollow extends UseCase<
  { readonly sellerId?: unknown },
  FollowState,
  FollowFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.view-store-follow',
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
    return viewFollow(this.deps, context, input);
  }
}

export type { FollowState } from '../store-follow-flow';
