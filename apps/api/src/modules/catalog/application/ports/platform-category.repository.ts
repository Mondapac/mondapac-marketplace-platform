import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PlatformCategory } from '../../domain/platform-category';

/** The tree version row of a Market and the guard that serialises structural edits. */
export interface CategoryTreeVersion {
  readonly version: number;
}

/**
 * The store of the platform category tree (catalog data design 3.4). Every method runs in the
 * open unit of the use case, through the Market-scoped client.
 */
export interface PlatformCategoryRepository {
  /**
   * The Market's tree version, creating the row at 1 when the Market has none yet (a no-op
   * when it exists, taking no lock).
   */
  treeVersion(market: MarketContext): Promise<CategoryTreeVersion>;

  /**
   * Raises the tree version from `expected` by one. Throws `StaleAggregateError` when another
   * structural change committed since it was read (two moves that would form a cycle together
   * cannot both commit).
   */
  bumpTreeVersion(market: MarketContext, expected: number): Promise<void>;

  /** The id of the category with this slug in this Market, or null. */
  idBySlug(market: MarketContext, slug: string): Promise<Id<'Category'> | null>;

  /**
   * Inserts a category built by `PlatformCategory.create`: the root with no revision pointer,
   * revision 1 with its names, then the pointer, so the pointer is never null after commit.
   */
  add(market: MarketContext, category: PlatformCategory): Promise<void>;
}

export const PLATFORM_CATEGORY_REPOSITORY = Symbol('PLATFORM_CATEGORY_REPOSITORY');
