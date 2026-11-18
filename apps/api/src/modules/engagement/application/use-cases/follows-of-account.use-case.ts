import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import { followsOfAccount, type FollowFailure } from '../store-follow-flow';

/** `engagement.follows-of-account`: every store an account follows (customers' per-seller read model) (rule `system`). */
export class FollowsOfAccount extends UseCase<
  { readonly accountId: Id<'Account'> },
  readonly { readonly sellerId: Id<'Seller'>; readonly followedAt: Temporal.Instant }[],
  FollowFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.follows-of-account',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EngagementDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly accountId: Id<'Account'> }) {
    return followsOfAccount(this.deps, context, input);
  }
}
