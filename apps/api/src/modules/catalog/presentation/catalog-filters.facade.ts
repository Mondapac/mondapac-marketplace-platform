import type { CallContext } from '@mondapac/shared-kernel';
import type { SearchFiltersQuery } from '../application/use-cases/search-filters.use-case';
import type {
  CatalogFiltersFacade,
  SearchFiltersRequest,
} from '../contracts/catalog-filters.facade';

/** Passes the caller's `CallContext` unchanged to the filter list use case, so the gate runs. */
export class CatalogFiltersFacadeImplementation implements CatalogFiltersFacade {
  constructor(private readonly query: SearchFiltersQuery) {}

  filters(context: CallContext, request: SearchFiltersRequest) {
    return this.query.execute(context, request);
  }
}
