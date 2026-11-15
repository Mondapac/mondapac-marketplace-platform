import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { ScopeRow } from '../../domain/scope-counts';
import type { OfferFacetReader } from './offer-facet.reader';
import type { OfferSearchReader } from './offer-search.reader';
import type { StoreSearchReader } from './store-search.reader';
import type { SuggestReader } from './suggest.reader';

/** The text and category of a query: what the counts read. Filters are not part of it. */
export interface ScopeRequest {
  readonly textSearchConfig: string;
  readonly text: string | null;
  readonly categoryIds: readonly Id<'Category'>[] | null;
}

/** What the counts need of a scope. */
export interface OfferScopeReader {
  /**
   * One row per indexed Offer of the scope, by Offer id, at most `MAX_SCOPE_ROWS + 1` (one more
   * than the cap, so a cut is known). A text or a category is needed.
   */
  scopeRows(market: MarketContext, scope: ScopeRequest): Promise<readonly ScopeRow[]>;
}

/**
 * The search index the use cases talk to (option B, search 1a): ranked text search, the browse, the
 * filter reads, the scope counts and (search 1b) the suggest reads, in one port. The PostgreSQL full-text adapter is the only one
 * today (ADR-0004); a dedicated engine would be another adapter behind this port, with no change to
 * the use cases or to apps/web. Every method runs in the caller's read-only unit, for the context's
 * Market only.
 */
export interface OfferSearchIndex
  extends OfferSearchReader, OfferFacetReader, OfferScopeReader, StoreSearchReader, SuggestReader {}

export const OFFER_SEARCH_INDEX = Symbol('OFFER_SEARCH_INDEX');
