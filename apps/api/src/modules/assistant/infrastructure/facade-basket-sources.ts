import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { SearchAssistantFacade } from '../../search';
import type { BasketSources } from '../application/ports/basket-sources';
import type { BasketCandidate, CartMode } from '../domain/plan-basket';

/** How many results of one line the planner looks at (the storefront search's own order). */
export const CANDIDATES_PER_LINE = 8;

/**
 * {@link BasketSources} on the READ facade of `search` (one storefront search per line) and on
 * the Market's cart mode as `settings` publishes it. Prices are pricing's, read by search.
 */
export class FacadeBasketSources implements BasketSources {
  constructor(
    private readonly search: SearchAssistantFacade,
    private readonly readCartMode: (context: CallContext) => Promise<CartMode>,
  ) {}

  async candidates(
    context: CallContext,
    text: string,
  ): Promise<Result<readonly BasketCandidate[], { readonly code: 'unavailable' }>> {
    const found = await this.search.searchProducts(context, {
      text,
      categoryId: null,
      limit: CANDIDATES_PER_LINE,
    });
    if (!found.ok) {
      // A line the search refuses (for example, too short) has no result; a failed read is an error.
      return found.error.code === 'validation.failed' ? ok([]) : err({ code: 'unavailable' });
    }
    return ok(
      found.value.map((item) => ({
        offerId: item.offerId,
        productId: item.productId,
        sellerId: item.sellerId,
        sellerName: item.sellerName,
        name: item.name,
        price: item.price,
        priceFrom: item.priceFrom,
        taxInclusive: item.taxInclusive,
      })),
    );
  }

  async cartMode(context: CallContext): Promise<CartMode> {
    try {
      return await this.readCartMode(context);
    } catch {
      return 'multi-store';
    }
  }
}
