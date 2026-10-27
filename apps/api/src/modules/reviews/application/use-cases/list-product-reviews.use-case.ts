import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReviewsFailure } from '../failures';
import {
  listProductReviews,
  type ListProductReviewsInput,
  type ProductReviewsPage,
} from '../read-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

/** `reviews.list-product-reviews`: the public, published reviews of a product (anonymous; names read at read time). */
export class ListProductReviews extends UseCase<
  ListProductReviewsInput,
  ProductReviewsPage,
  ReviewsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.list-product-reviews',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ListProductReviewsInput) {
    return listProductReviews(this.deps, context, input);
  }
}

export type { ProductReviewsPage } from '../read-flow';
