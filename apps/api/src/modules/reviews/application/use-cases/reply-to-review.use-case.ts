import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_SELLER_REPLY } from '../../contracts/permissions';
import type { ReviewsFailure } from '../failures';
import type { ReviewsDependencies } from '../reviews-dependencies';
import { writeReply, type SellerReviewView } from '../seller-flow';

/** `reviews.reply-to-review`: The shop's one public reply to a published review of its own. */
export class ReplyToReview extends UseCase<
  { readonly reviewId?: unknown; readonly body?: unknown },
  SellerReviewView,
  ReviewsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.reply-to-review',
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
    return writeReply(this.deps, context, input, 'create');
  }
}

export type { SellerReviewView } from '../seller-flow';
