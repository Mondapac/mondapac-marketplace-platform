import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_SELLER_VIEW } from '../../contracts/permissions';
import type { ReviewsFailure } from '../failures';
import type { ReviewsDependencies } from '../reviews-dependencies';
import { listSellerReviews, type SellerReviewsPage } from '../seller-flow';

/** `reviews.list-seller-reviews`: The shop's own published reviews, with the order reference and the shop's reply. Never the buyer. */
export class ListSellerReviews extends UseCase<
  { readonly cursor?: unknown },
  SellerReviewsPage,
  ReviewsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.list-seller-reviews',
    rule: { kind: 'permissions', allOf: [REVIEWS_SELLER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly cursor?: unknown }) {
    return listSellerReviews(this.deps, context, input);
  }
}

export type { SellerReviewsPage } from '../seller-flow';
export type { SellerReplyView, SellerReviewView } from '../seller-flow';
