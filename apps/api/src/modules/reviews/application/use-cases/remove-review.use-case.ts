import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_MODERATION_REMOVE } from '../../contracts/permissions';
import type { ModeratorAction } from '../../domain/moderation';
import {
  moderateReview,
  type ModerateInput,
  type ModerationDetailView,
  type ModerationFailure,
} from '../moderation-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

const ACTIONS: readonly ModeratorAction[] = ['remove'];

/** `reviews.remove-review`: Removes a review for illegal, defamatory or private content (protected key). Spends the admin's two-step proof, except for a dismissal. */
export class RemoveReview extends UseCase<ModerateInput, ModerationDetailView, ModerationFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.remove-review',
    rule: { kind: 'permissions', allOf: [REVIEWS_MODERATION_REMOVE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ModerateInput) {
    return moderateReview(this.deps, context, input, ACTIONS);
  }
}
