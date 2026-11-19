import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { ScopeRow } from '../../domain/scope-counts';
import type { SuggestQuery } from '../../domain/suggest-query';

/** What every suggest read needs: the Market's configuration and the checked query. */
export interface SuggestRequest {
  /** The Market's text search configuration. */
  readonly textSearchConfig: string;
  readonly query: SuggestQuery;
}

/** An Offer the suggest query found, before catalog and sellers have re-checked it. */
export interface SuggestOfferHit {
  readonly offerId: Id<'Offer'>;
  readonly productId: Id<'Product'>;
  readonly sellerId: Id<'Seller'>;
  readonly name: string;
  readonly categoryIds: readonly Id<'Category'>[];
  /** 0: the name starts with the query, 1: the name has every word, 2: seller or category only. */
  readonly tier: number;
  readonly rank: number;
}

/** A store the suggest query found, before sellers has re-checked it. */
export interface SuggestStoreHit {
  readonly sellerId: Id<'Seller'>;
  readonly slug: string;
  readonly name: string;
  /** 0: the store name starts with the query, 1: it has every word, 2: one of its products matches. */
  readonly tier: number;
  readonly rank: number;
}

/**
 * The suggest reads of the index (search 1b): every typed word must match, the last one as a prefix.
 * All run in the caller's read-only unit, for the context's Market only.
 */
export interface SuggestReader {
  /** One Offer per product (its best), in order (tier, rank, name, product id), at most `limit`. */
  suggestOffers(
    market: MarketContext,
    request: SuggestRequest,
    limit: number,
  ): Promise<readonly SuggestOfferHit[]>;
  /** One row per matching product, at most `MAX_SUGGEST_SCOPE_PRODUCTS + 1` (one more so a cut is known). */
  suggestScopeRows(market: MarketContext, request: SuggestRequest): Promise<readonly ScopeRow[]>;
  /** Stores with an indexed Offer that matches, in order (tier, rank, name, seller id). */
  suggestStores(
    market: MarketContext,
    request: SuggestRequest,
    limit: number,
  ): Promise<readonly SuggestStoreHit[]>;
}
