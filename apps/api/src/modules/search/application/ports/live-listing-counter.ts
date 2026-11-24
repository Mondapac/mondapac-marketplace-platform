import type { MarketContext } from '@mondapac/shared-kernel';
import type { LiveListingCounts } from '../../contracts/search-supply.facade';

export type { LiveListingCounts };

/**
 * Two counts over the search read model (dashboards v2, phase 1, PR 6: the admin dashboard's
 * supply and health card). Inside a read-only unit, scoped to the Market. Counts only.
 */
export interface LiveListingCounter {
  liveListings(market: MarketContext): Promise<LiveListingCounts>;
}

export const LIVE_LISTING_COUNTER = Symbol('search.LiveListingCounter');
