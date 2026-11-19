import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_SELLER_VIEW } from '../../contracts/permissions';
import {
  listSellerReviewRows,
  type SellerReviewListDependencies,
  type SellerReviewListFailure,
  type SellerReviewListInput,
  type SellerReviewListPage,
} from '../seller-review-list-flow';

export type { SellerReviewListPage } from '../seller-review-list-flow';

/**
 * `reviews.query-seller-reviews` (super list 32): the shop lists its own published reviews with
 * views and counts, filters, sort, page numbers or Previous/Next and each row's actions. Same key
 * as the older cursor list (`reviews.seller.view`); it reads the same reviews. Never the buyer.
 */
export class QuerySellerReviews extends UseCase<
  SellerReviewListInput,
  SellerReviewListPage,
  SellerReviewListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.query-seller-reviews',
    rule: { kind: 'permissions', allOf: [REVIEWS_SELLER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerReviewListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: SellerReviewListInput) {
    return listSellerReviewRows(this.deps, context, input);
  }
}
