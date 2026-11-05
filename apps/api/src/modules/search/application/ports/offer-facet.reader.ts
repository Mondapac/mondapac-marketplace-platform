import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { OfferHit } from '../../domain/offer-document';
import type { RangeFilter } from '../../domain/search-filter';
import type { OfferSearchRequest } from './offer-search.reader';

/**
 * A text search or a category browse narrowed by attribute filters (attributes A7). A choice group
 * is the facet strings (`attribute=value`) of one attribute's picked values: a document must hold
 * one of each group's values. A range keeps documents whose number of the attribute lies between
 * the bounds (a document without that number is out). At most `MAX_CHOICE_FILTERS` groups and
 * `MAX_RANGE_FILTERS` ranges.
 */
export interface FilteredSearchRequest extends OfferSearchRequest {
  readonly choiceGroups: readonly (readonly string[])[];
  readonly ranges: readonly RangeFilter[];
}

/** The scope of a facet read: the text and category of the query, with its range filters. */
export interface FacetScope {
  readonly textSearchConfig: string;
  readonly text: string | null;
  readonly categoryIds: readonly Id<'Category'>[] | null;
  readonly ranges: readonly RangeFilter[];
}

/** One document of the scope, as counting needs it. */
export interface FacetRow {
  readonly productId: Id<'Product'>;
  readonly facets: readonly string[];
}

/** One stored number of the scope. */
export interface NumberRow {
  readonly attr: string;
  readonly value: string;
}

/** The most rows a facet or number read returns; one more is read so the caller knows it was cut. */
export const MAX_FACET_ROWS = 20_000;

/**
 * The filter side of the query reads. All three run in the caller's read-only unit; documents of
 * the context's Market only.
 */
export interface OfferFacetReader {
  /** Hits as `OfferSearchReader.search` gives them (rating boost and `top-rated` included), narrowed by the filters. */
  searchFiltered(
    market: MarketContext,
    request: FilteredSearchRequest,
  ): Promise<readonly OfferHit[]>;
  /** The documents of the scope with their facets, at most `MAX_FACET_ROWS + 1`. */
  facetRows(market: MarketContext, scope: FacetScope): Promise<readonly FacetRow[]>;
  /** The stored numbers of these attributes in the scope, at most `MAX_FACET_ROWS + 1`. */
  numberRows(
    market: MarketContext,
    scope: FacetScope,
    attrs: readonly string[],
  ): Promise<readonly NumberRow[]>;
}

export const OFFER_FACET_READER = Symbol('OFFER_FACET_READER');
