import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReviewsFailure } from '../failures';
import { castHelpfulVote, type HelpfulVoteInput, type HelpfulVoteView } from '../helpful-flow';

export type { HelpfulVoteView };
import type { ReviewsDependencies } from '../reviews-dependencies';

/** `reviews.cast-helpful-vote`: the signed-in buyer marks a published review helpful (once; idempotent). */
export class CastHelpfulVote extends UseCase<HelpfulVoteInput, HelpfulVoteView, ReviewsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.cast-helpful-vote',
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
    return castHelpfulVote(this.deps, context, input);
  }
}
