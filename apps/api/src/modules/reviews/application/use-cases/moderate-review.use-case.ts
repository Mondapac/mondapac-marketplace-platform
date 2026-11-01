import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_MODERATION_MODERATE } from '../../contracts/permissions';
import type { ModeratorAction } from '../../domain/moderation';
import {
  moderateReview,
  type ModerateInput,
  type ModerationDetailView,
  type ModerationFailure,
} from '../moderation-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

const ACTIONS: readonly ModeratorAction[] = ['publish', 'hide', 'restore', 'dismiss-reports'];

/** `reviews.moderate-review`: Publishes a held review, hides or restores a review, or dismisses its open reports. Spends the admin's two-step proof, except for a dismissal. */
export class ModerateReview extends UseCase<
  ModerateInput,
  ModerationDetailView,
  ModerationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.moderate-review',
    rule: { kind: 'permissions', allOf: [REVIEWS_MODERATION_MODERATE.key] },
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
