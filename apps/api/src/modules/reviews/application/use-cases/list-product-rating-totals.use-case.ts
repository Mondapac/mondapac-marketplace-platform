import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ProductRatingTotalsPage } from '../../contracts/reviews.facade';
import type { SummaryFailure } from '../failures';
import { productRatingTotals, type ProductRatingTotalsInput } from '../rating-totals-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

/** `reviews.list-product-rating-totals`: the star totals of products with published reviews, for search's staged rating boost (rule `system`). */
export class ListProductRatingTotals extends UseCase<
  ProductRatingTotalsInput,
  ProductRatingTotalsPage,
  SummaryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.list-product-rating-totals',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ProductRatingTotalsInput) {
    return productRatingTotals(this.deps, context, input);
  }
}
