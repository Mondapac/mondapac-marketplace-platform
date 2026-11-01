import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_MODERATION_QUEUE } from '../../contracts/permissions';
import {
  viewModerationReview,
  type ModerationDetailView,
  type ModerationFailure,
} from '../moderation-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

export type { ModerationDetailView } from '../moderation-flow';

/** `reviews.view-moderation-review`: One review for a moderator, with its open reports, signals and history. Needs `reviews.moderation.queue`. */
export class ViewModerationReview extends UseCase<
  { readonly reviewId?: unknown },
  ModerationDetailView,
  ModerationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.view-moderation-review',
    rule: { kind: 'permissions', allOf: [REVIEWS_MODERATION_QUEUE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly reviewId?: unknown }) {
    return viewModerationReview(this.deps, context, input);
  }
}
