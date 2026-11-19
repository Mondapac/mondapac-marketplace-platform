import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { CultureCategoryRow } from '../../domain/culture-category';
import type { CultureState } from '../../domain/culture';

/** Why a write was refused by a unique index. */
export type CultureConflict =
  | 'culture.code-taken'
  | 'culture.name-taken'
  // Another unit made a culture the default first (the one-default index): the caller's view is stale.
  | 'conflict.stale';

/**
 * The store of cultures with their names and category marks (multi-culture package 1). Every method
 * runs in the open unit of the use case and answers for the unit's Market. There is no delete: a
 * culture is made inactive (ADR-0047 decision 1).
 */
export interface CultureRepository {
  /** Inserts a new culture with its names. */
  add(market: MarketContext, state: CultureState): Promise<CultureConflict | null>;

  findById(market: MarketContext, id: Id<'Culture'>): Promise<CultureState | null>;

  /** Whether a culture of the Market already uses this code. */
  codeTaken(market: MarketContext, code: string): Promise<boolean>;

  /** The id of the Market's default culture, or null when none is marked. */
  defaultId(market: MarketContext): Promise<Id<'Culture'> | null>;

  /** How many cultures the Market has, in any status. */
  count(market: MarketContext): Promise<number>;

  /**
   * Writes a changed culture under the version it was read at and replaces its names. Throws
   * `StaleAggregateError` when the row changed since.
   */
  save(
    market: MarketContext,
    state: CultureState,
    expectedVersion: number,
  ): Promise<CultureConflict | null>;

  /** Clears the default mark of every culture of the Market but `exceptId`. */
  clearDefaultExcept(
    market: MarketContext,
    exceptId: Id<'Culture'>,
    now: Temporal.Instant,
  ): Promise<void>;

  /** The stored marks of one culture, by category id. */
  categoryRows(
    market: MarketContext,
    cultureId: Id<'Culture'>,
  ): Promise<readonly CultureCategoryRow[]>;

  /**
   * The category rows of several cultures in one statement (`culture_id = ANY`), per culture; a
   * culture with no row maps to an empty list.
   */
  categoryRowsOf(
    market: MarketContext,
    cultureIds: readonly Id<'Culture'>[],
  ): Promise<ReadonlyMap<Id<'Culture'>, readonly CultureCategoryRow[]>>;

  /** Creates or replaces the mark row of one category. */
  setCategoryRow(
    market: MarketContext,
    cultureId: Id<'Culture'>,
    row: CultureCategoryRow,
    updatedBy: Id<'Account'>,
    now: Temporal.Instant,
  ): Promise<void>;

  /** Removes the mark row of one category; false when there was none. */
  clearCategoryRow(
    market: MarketContext,
    cultureId: Id<'Culture'>,
    categoryId: Id<'Category'>,
  ): Promise<boolean>;
}

export const CULTURE_REPOSITORY = Symbol('CULTURE_REPOSITORY');
