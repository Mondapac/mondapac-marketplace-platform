import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { BusinessActivityState } from '../../domain/business-activity';

/** Why a write was refused by a unique index. */
export type BusinessActivityConflict =
  'business-activity.code-taken' | 'business-activity.name-taken';

/**
 * The store of business activities with their names and category links (catalog business-activity
 * package). Every method runs in the open unit of the use case and answers for the unit's Market.
 */
export interface BusinessActivityRepository {
  /** Inserts a new activity with its names and links. */
  add(
    market: MarketContext,
    state: BusinessActivityState,
  ): Promise<BusinessActivityConflict | null>;

  findById(
    market: MarketContext,
    id: Id<'BusinessActivity'>,
  ): Promise<BusinessActivityState | null>;

  /** Whether an activity of the Market already uses this code. */
  codeTaken(market: MarketContext, code: string): Promise<boolean>;

  /**
   * Writes a changed activity under the version it was read at and replaces its names and links.
   * Throws `StaleAggregateError` when the row changed since.
   */
  save(
    market: MarketContext,
    state: BusinessActivityState,
    expectedVersion: number,
  ): Promise<BusinessActivityConflict | null>;
}

export const BUSINESS_ACTIVITY_REPOSITORY = Symbol('BUSINESS_ACTIVITY_REPOSITORY');
