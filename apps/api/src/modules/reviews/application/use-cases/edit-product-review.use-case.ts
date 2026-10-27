import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReviewsFailure } from '../failures';
import type { OwnReviewView } from '../views';
import { editProductReview, type EditReviewInput } from '../write-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

/** `reviews.edit-product-review`: the author edits their own review up to the Market's edit window. */
export class EditProductReview extends UseCase<EditReviewInput, OwnReviewView, ReviewsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.edit-product-review',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: EditReviewInput) {
    return editProductReview(this.deps, context, input);
  }
}

export type { OwnReviewView, PublicReviewView } from '../views';
