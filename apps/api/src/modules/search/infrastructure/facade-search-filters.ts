import type { CallContext } from '@mondapac/shared-kernel';
import type { CatalogFiltersFacade } from '../../catalog';
import type { FilterDefinition, SearchFilterSource } from '../application/ports/search-filters';

/**
 * {@link SearchFilterSource} over catalog's filter facade (rule `anonymous`), with the request's
 * context unchanged. Any refusal or failure is `null`.
 */
export class FacadeSearchFilters implements SearchFilterSource {
  constructor(private readonly catalog: CatalogFiltersFacade) {}

  async filters(
    context: CallContext,
    request: Parameters<SearchFilterSource['filters']>[1],
  ): Promise<readonly FilterDefinition[] | null> {
    try {
      const answer = await this.catalog.filters(context, request);
      return answer.ok ? answer.value : null;
    } catch {
      return null;
    }
  }
}
