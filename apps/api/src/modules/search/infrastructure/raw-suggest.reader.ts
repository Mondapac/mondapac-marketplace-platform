import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { RawReadPort } from '../../../platform/persistence/raw-reads/raw-read-port';
import type {
  SuggestOfferHit,
  SuggestReader,
  SuggestRequest,
  SuggestStoreHit,
} from '../application/ports/suggest.reader';
import {
  MAX_SUGGEST_CANDIDATE_OFFERS,
  MAX_SUGGEST_CANDIDATE_STORES,
  MAX_SUGGEST_SCOPE_PRODUCTS,
} from '../domain/suggest-query';
import type { ScopeRow } from '../domain/scope-counts';

const limitOf = (value: number, max: number): string => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError('search: suggest limit out of range');
  }
  return String(value);
};

/**
 * {@link SuggestReader} over the module's raw read port: three listed statements (one Offer per product in the first two), bound parameters
 * only (the prefix query text `$3` and both name patterns are built from the visitor's words by
 * `parseSuggestQuery`, and travel as values, never as SQL).
 */
export class RawSuggestReader implements SuggestReader {
  constructor(private readonly rawReads: RawReadPort) {}

  async suggestOffers(
    market: MarketContext,
    request: SuggestRequest,
    limit: number,
  ): Promise<readonly SuggestOfferHit[]> {
    const rows = await this.rawReads.rawRead(market, 'search.offer-suggest', {
      textSearchConfig: request.textSearchConfig,
      query: request.query.tsQuery,
      nameQuery: request.query.nameQuery,
      startsWith: request.query.startsWith,
      firstWordStarts: request.query.firstWordStarts,
      contains: request.query.contains,
      limit: limitOf(limit, MAX_SUGGEST_CANDIDATE_OFFERS),
    });
    return rows.map((row) => ({
      offerId: row.offerId as Id<'Offer'>,
      productId: row.productId as Id<'Product'>,
      sellerId: row.sellerId as Id<'Seller'>,
      name: row.name,
      categoryIds: row.categoryIds as Id<'Category'>[],
      tier: row.tier,
      rank: row.rank,
    }));
  }

  async suggestScopeRows(
    market: MarketContext,
    request: SuggestRequest,
  ): Promise<readonly ScopeRow[]> {
    const rows = await this.rawReads.rawRead(market, 'search.offer-suggest-scope-rows', {
      textSearchConfig: request.textSearchConfig,
      query: request.query.tsQuery,
      limit: String(MAX_SUGGEST_SCOPE_PRODUCTS + 1),
    });
    return rows.map((row) => ({
      productId: row.productId as Id<'Product'>,
      sellerId: row.sellerId as Id<'Seller'>,
      categoryIds: row.categoryIds as Id<'Category'>[],
    }));
  }

  async suggestStores(
    market: MarketContext,
    request: SuggestRequest,
    limit: number,
  ): Promise<readonly SuggestStoreHit[]> {
    const rows = await this.rawReads.rawRead(market, 'search.store-suggest', {
      textSearchConfig: request.textSearchConfig,
      query: request.query.tsQuery,
      nameQuery: request.query.nameQuery,
      startsWith: request.query.startsWith,
      firstWordStarts: request.query.firstWordStarts,
      contains: request.query.contains,
      limit: limitOf(limit, MAX_SUGGEST_CANDIDATE_STORES),
    });
    return rows.map((row) => ({
      sellerId: row.sellerId as Id<'Seller'>,
      slug: row.slug,
      name: row.name,
      tier: row.tier,
      rank: row.rank,
    }));
  }
}
