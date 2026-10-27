import type { CallContext, Id } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ReviewsFailure } from '../failures';
import { deleteProductReview } from '../write-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

/** `reviews.delete-product-review`: the author deletes their own review, at any time (the row stays, the text goes). */
export class DeleteProductReview extends UseCase<
  { readonly reviewId?: unknown },
  { readonly id: Id<'ProductReview'>; readonly status: 'deleted-by-author' },
  ReviewsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.delete-product-review',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly reviewId?: unknown }) {
    return deleteProductReview(this.deps, context, input);
  }
}
