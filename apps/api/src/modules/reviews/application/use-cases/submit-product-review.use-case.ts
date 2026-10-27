import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReviewsFailure } from '../failures';
import { submitProductReview, type SubmitReviewInput, type SubmittedReview } from '../write-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

/**
 * `reviews.submit-product-review`: a verified buyer reviews a product (rule `own-resources`; refused in
 * an acting-as session). Eligibility is asked of ordering at write time; a clean text publishes at
 * once, a flagged one is held. One review per account and product.
 */
export class SubmitProductReview extends UseCase<
  SubmitReviewInput,
  SubmittedReview,
  ReviewsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.submit-product-review',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: SubmitReviewInput) {
    return submitProductReview(this.deps, context, input);
  }
}

export type { SubmittedReview } from '../write-flow';
