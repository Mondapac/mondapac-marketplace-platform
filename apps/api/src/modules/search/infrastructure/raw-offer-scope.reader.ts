import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { RawReadPort } from '../../../platform/persistence/raw-reads/raw-read-port';
import type { OfferScopeReader, ScopeRequest } from '../application/ports/offer-search-index';
import { MAX_FILTER_CATEGORIES } from '../domain/category-subtree';
import { MAX_SCOPE_ROWS, type ScopeRow } from '../domain/scope-counts';

/**
 * {@link OfferScopeReader} over the module's raw read port: one listed statement, bound parameters
 * only (the visitor's text is `$3`).
 */
export class RawOfferScopeReader implements OfferScopeReader {
  constructor(private readonly rawReads: RawReadPort) {}

  async scopeRows(market: MarketContext, scope: ScopeRequest): Promise<readonly ScopeRow[]> {
    const categoryIds = scope.categoryIds ?? [];
    if (
      scope.categoryIds !== null &&
      (categoryIds.length < 1 || categoryIds.length > MAX_FILTER_CATEGORIES)
    ) {
      throw new RangeError('search: category filter size out of range');
    }
    const text = scope.text ?? '';
    if (text === '' && categoryIds.length === 0) {
      throw new RangeError('search: a count needs a text or a category');
    }
    const rows = await this.rawReads.rawRead(market, 'search.offer-scope-rows', {
      textSearchConfig: scope.textSearchConfig,
      query: text,
      categoryIds,
      limit: String(MAX_SCOPE_ROWS + 1),
    });
    return rows.map((row) => ({
      productId: row.productId as Id<'Product'>,
      sellerId: row.sellerId as Id<'Seller'>,
      categoryIds: row.categoryIds as Id<'Category'>[],
    }));
  }
}
