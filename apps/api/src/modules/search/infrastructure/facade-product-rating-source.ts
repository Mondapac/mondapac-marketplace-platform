import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { ReviewsFacade } from '../../reviews';
import type { ProductRatingPage, ProductRatingSource } from '../application/ports/product-rating';

/**
 * {@link ProductRatingSource} over reviews' `productRatingTotals`. Reviews off in the Market is
 * `disabled`; any other refusal or a thrown error is `null` (the sync leaves its copy alone).
 */
export class FacadeProductRatingSource implements ProductRatingSource {
  constructor(private readonly reviews: ReviewsFacade) {}

  async page(
    context: CallContext,
    request: { readonly after: Id<'Product'> | null; readonly limit: number },
  ): Promise<ProductRatingPage | 'disabled' | null> {
    try {
      const answer = await this.reviews.productRatingTotals(context, request);
      if (answer.ok) return answer.value;
      return answer.error.code === 'reviews.disabled' ? 'disabled' : null;
    } catch {
      return null;
    }
  }
}
