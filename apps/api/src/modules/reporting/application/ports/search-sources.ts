import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { FunnelUnavailable } from './engagement-sources';

/** A text found nothing for on a Market day and searched by at least ten distinct customers. */
export interface ZeroResultSearchCount {
  readonly query: string;
  readonly searchers: number;
  readonly searches: number;
}

/**
 * What the nightly zero-result snapshot reads of the owners (dashboards v2, phase 2): search's
 * zero-result texts of the window handed to engagement's searcher count, as the system actor. Only
 * texts with counts come back; no person is named anywhere in the hand-off.
 */
export interface SearchSources {
  zeroResultSearchesOf(
    context: CallContext,
    window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant },
  ): Promise<Result<readonly ZeroResultSearchCount[], FunnelUnavailable>>;
}

export const SEARCH_SOURCES = Symbol('reporting.SearchSources');
