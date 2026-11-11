import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  FacetRow,
  FacetScope,
  FilteredSearchRequest,
  NumberRow,
  OfferFacetReader,
} from '../application/ports/offer-facet.reader';
import type {
  OfferSearchReader,
  OfferSearchRequest,
} from '../application/ports/offer-search.reader';
import type {
  OfferScopeReader,
  OfferSearchIndex,
  ScopeRequest,
} from '../application/ports/offer-search-index';
import type { OfferHit } from '../domain/offer-document';
import type {
  StoreSearchReader,
  StoreSearchRequest,
} from '../application/ports/store-search.reader';
import type { StoreHit } from '../domain/store-document';
import type { ScopeRow } from '../domain/scope-counts';

/**
 * {@link OfferSearchIndex} over PostgreSQL full-text search (ADR-0004): the three raw readers behind
 * one port. The only adapter; a dedicated engine would replace it here.
 */
export class PostgresOfferSearchIndex implements OfferSearchIndex {
  constructor(
    private readonly search_: OfferSearchReader,
    private readonly facets_: OfferFacetReader,
    private readonly scope_: OfferScopeReader,
    private readonly stores_: StoreSearchReader,
  ) {}

  search(market: MarketContext, request: OfferSearchRequest): Promise<readonly OfferHit[]> {
    return this.search_.search(market, request);
  }
  searchFiltered(
    market: MarketContext,
    request: FilteredSearchRequest,
  ): Promise<readonly OfferHit[]> {
    return this.facets_.searchFiltered(market, request);
  }
  facetRows(market: MarketContext, scope: FacetScope): Promise<readonly FacetRow[]> {
    return this.facets_.facetRows(market, scope);
  }
  numberRows(
    market: MarketContext,
    scope: FacetScope,
    attrs: readonly string[],
  ): Promise<readonly NumberRow[]> {
    return this.facets_.numberRows(market, scope, attrs);
  }
  scopeRows(market: MarketContext, scope: ScopeRequest): Promise<readonly ScopeRow[]> {
    return this.scope_.scopeRows(market, scope);
  }
  searchStores(market: MarketContext, request: StoreSearchRequest): Promise<readonly StoreHit[]> {
    return this.stores_.searchStores(market, request);
  }
}
