import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReviewsFailure } from '../failures';
import { listMyReviews, type MyReviewsView } from '../read-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

/** `reviews.list-my-reviews`: the buyer's own reviews and seller ratings, any status but deleted. */
export class ListMyReviews extends UseCase<Record<string, never>, MyReviewsView, ReviewsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.list-my-reviews',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return listMyReviews(this.deps, context);
  }
}

export type { MyReviewsView } from '../read-flow';
