import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { EngagementFacade } from '../../engagement';
import type { SearchReportingFacade } from '../../search';
import type { FunnelUnavailable } from '../application/ports/engagement-sources';
import type { SearchSources, ZeroResultSearchCount } from '../application/ports/search-sources';

/**
 * {@link SearchSources} on search's `zeroResultTexts` and engagement's `searchShoppers`: the texts
 * search found nothing for in the window go to engagement unchanged, and only texts searched by at
 * least ten distinct customers come back, with counts. No id passes either way.
 */
export class FacadeSearchSources implements SearchSources {
  constructor(
    private readonly search: Pick<SearchReportingFacade, 'zeroResultTexts'>,
    private readonly engagement: Pick<EngagementFacade, 'searchShoppers'>,
  ) {}

  async zeroResultSearchesOf(
    context: CallContext,
    window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant },
  ): Promise<Result<readonly ZeroResultSearchCount[], FunnelUnavailable>> {
    const texts = await this.search.zeroResultTexts(context, { window });
    if (!texts.ok) return err({ code: `search:${texts.error.code}` });
    if (texts.value.texts.length === 0) return ok([]);
    const counts = await this.engagement.searchShoppers(context, {
      window,
      queries: texts.value.texts,
    });
    if (!counts.ok) {
      return err({
        code: `engagement:${counts.error.code}`,
        ...(counts.error.code === 'engagement.search-too-large' ? { overCap: true } : {}),
      });
    }
    return ok(
      counts.value.map((row) => ({
        query: row.query,
        searchers: row.shoppers,
        searches: row.searches,
      })),
    );
  }
}
