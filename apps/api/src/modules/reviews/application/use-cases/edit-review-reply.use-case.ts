import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_SELLER_REPLY } from '../../contracts/permissions';
import type { ReviewsFailure } from '../failures';
import type { ReviewsDependencies } from '../reviews-dependencies';
import { writeReply, type SellerReviewView } from '../seller-flow';

/** `reviews.edit-review-reply`: Changes the shop's reply while the Market's edit window is open. */
export class EditReviewReply extends UseCase<
  { readonly reviewId?: unknown; readonly body?: unknown },
  SellerReviewView,
  ReviewsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.edit-review-reply',
    rule: { kind: 'permissions', allOf: [REVIEWS_SELLER_REPLY.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly reviewId?: unknown; readonly body?: unknown },
  ) {
    return writeReply(this.deps, context, input, 'edit');
  }
}

export type { SellerReviewView } from '../seller-flow';
