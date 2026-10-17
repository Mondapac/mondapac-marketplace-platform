import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * The live paths of platform categories (catalog design 5.1 `platformCategoryPaths`, 4.6): per
 * category id, in the order given, the path root first on the live tree. A merged category, named
 * or ancestor, is followed to the one it was merged into; an archived category is dropped: a named
 * one gives no path, an archived ancestor is left out of the path and its parent kept. Repeated
 * paths appear once. Never a seller category (AC 11). Runs in the caller's unit through the
 * Market-scoped client.
 *
 * Fail closed (Hassan M3): a category that cannot be read (unknown, another Market's), a merge or
 * parent loop, or a path deeper than the tree allows throws {@link CategoryPathsUnavailableError};
 * the command answers `claim.check-unavailable` and never asks on a partial path.
 */
export interface CategoryPathsReader {
  livePaths(
    market: MarketContext,
    categoryIds: readonly string[],
  ): Promise<readonly (readonly Id<'Category'>[])[]>;
}

/** The paths cannot be built from the stored tree; nothing may be asked on them. */
export class CategoryPathsUnavailableError extends Error {
  constructor(reason: string) {
    super(`category paths unavailable: ${reason}`);
    this.name = 'CategoryPathsUnavailableError';
  }
}

export const CATEGORY_PATHS_READER = Symbol('CATEGORY_PATHS_READER');
