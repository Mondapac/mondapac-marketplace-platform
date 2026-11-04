import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { BusinessActivityState, BusinessActivityStatus } from '../../domain/business-activity';

export interface BusinessActivityListQuery {
  readonly status: BusinessActivityStatus | null;
  /** Matches a name in any locale or the code; case-insensitive. */
  readonly search: string | null;
  readonly afterId: Id<'BusinessActivity'> | null;
  readonly limit: number;
}

export interface BusinessActivityListPage {
  readonly items: readonly BusinessActivityState[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: Id<'BusinessActivity'> | null;
}

/** The reads of the business-activity package, in a read-only unit. */
export interface BusinessActivityReader {
  /** By code, then id; keyset-paged. */
  list(market: MarketContext, query: BusinessActivityListQuery): Promise<BusinessActivityListPage>;
}

export const BUSINESS_ACTIVITY_READER = Symbol('BUSINESS_ACTIVITY_READER');
