import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReviewsFailure } from '../failures';
import { removeHelpfulVote, type HelpfulVoteInput, type HelpfulVoteView } from '../helpful-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

/** `reviews.remove-helpful-vote`: the signed-in buyer takes their helpful vote back. */
export class RemoveHelpfulVote extends UseCase<HelpfulVoteInput, HelpfulVoteView, ReviewsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.remove-helpful-vote',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: HelpfulVoteInput) {
    return removeHelpfulVote(this.deps, context, input);
  }
}
