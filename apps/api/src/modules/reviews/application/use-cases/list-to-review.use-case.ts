import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReviewsFailure } from '../failures';
import { listToReview, type ToReviewView } from '../read-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

/** `reviews.list-to-review`: what the buyer can still review or rate (delivered, inside the window). */
export class ListToReview extends UseCase<Record<string, never>, ToReviewView, ReviewsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.list-to-review',
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
    return listToReview(this.deps, context);
  }
}

export type { ToReviewView } from '../read-flow';
