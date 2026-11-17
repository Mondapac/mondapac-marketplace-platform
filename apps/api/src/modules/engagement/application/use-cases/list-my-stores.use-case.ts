import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import { myStores, type FollowFailure, type MyStoresPage } from '../store-follow-flow';

/** `engagement.list-my-stores`: the customer's followed stores, newest first (rule `own-resources`). */
export class ListMyStores extends UseCase<
  { readonly cursor?: unknown; readonly limit?: unknown },
  MyStoresPage,
  FollowFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.list-my-stores',
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
    input: { readonly cursor?: unknown; readonly limit?: unknown },
  ) {
    return myStores(this.deps, context, input);
  }
}

export type { MyStoresPage } from '../store-follow-flow';
