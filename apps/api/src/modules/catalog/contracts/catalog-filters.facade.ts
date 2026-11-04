import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { SearchFilterDefinition } from '../domain/search-filters';

export type {
  SearchFilterDefinition,
  SearchFilterKind,
  SearchFilterOption,
} from '../domain/search-filters';

export interface SearchFiltersRequest {
  /** The category whose filter list (its own and its ancestors') applies; null: the global filters. */
  readonly categoryId: string | null;
  readonly locale: string;
  /** Brand addresses whose names the global Brand filter should show. */
  readonly brandSlugs: readonly string[];
  /** Lower case country codes whose names the global Country filter should show. */
  readonly countryCodes: readonly string[];
}

export interface SearchFilterUnavailable {
  readonly code: 'catalog.filters-unavailable';
}

/**
 * The filter lists catalog publishes for the storefront listing (attributes A7; rule `anonymous`,
 * the caller's `CallContext` unchanged). `search` asks for the definitions, then counts values in
 * its own index. In-process only.
 */
export interface CatalogFiltersFacade {
  filters(
    context: CallContext,
    request: SearchFiltersRequest,
  ): Promise<Result<readonly SearchFilterDefinition[], AccessDenied | SearchFilterUnavailable>>;
}

export const CATALOG_FILTERS_FACADE = Symbol('CATALOG_FILTERS_FACADE');
