import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * The live paths of platform categories (catalog design 5.1 `platformCategoryPaths`, 4.6): per
 * category id, in the order given, the path root first on the live tree; a merged category is
 * followed to the one it was merged into and an archived one is dropped. Repeated paths appear
 * once. Never a seller category (AC 11). Runs in the caller's unit through the Market-scoped
 * client; another Market's id is not found and is dropped.
 */
export interface CategoryPathsReader {
  livePaths(
    market: MarketContext,
    categoryIds: readonly string[],
  ): Promise<readonly (readonly Id<'Category'>[])[]>;
}

export const CATEGORY_PATHS_READER = Symbol('CATEGORY_PATHS_READER');
