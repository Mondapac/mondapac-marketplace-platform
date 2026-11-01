import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { DetachAuthor } from '../application/use-cases/detach-author.use-case';
import type { ListProductRatingTotals } from '../application/use-cases/list-product-rating-totals.use-case';
import type { ViewProductSummary } from '../application/use-cases/view-product-summary.use-case';
import type { ViewSellerSummary } from '../application/use-cases/view-seller-summary.use-case';
import type { ReviewsFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class ReviewsFacadeImplementation implements ReviewsFacade {
  constructor(
    private readonly productSummaryQuery: ViewProductSummary,
    private readonly sellerSummaryQuery: ViewSellerSummary,
    private readonly detach: DetachAuthor,
    private readonly ratingTotals: ListProductRatingTotals,
  ) {}

  productSummary(context: CallContext, productId: Id<'Product'>) {
    return this.productSummaryQuery.execute(context, { productId });
  }

  sellerSummary(context: CallContext, sellerId: Id<'Seller'>) {
    return this.sellerSummaryQuery.execute(context, { sellerId });
  }

  productRatingTotals(
    context: CallContext,
    request: { readonly after?: Id<'Product'> | null; readonly limit?: number },
  ) {
    return this.ratingTotals.execute(context, request);
  }

  detachAuthor(context: CallContext, accountId: Id<'Account'>) {
    return this.detach.execute(context, { accountId });
  }
}
