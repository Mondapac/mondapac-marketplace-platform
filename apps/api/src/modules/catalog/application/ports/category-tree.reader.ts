import type { MarketContext } from '@mondapac/shared-kernel';
import type { StoredCategoryNode } from '../../domain/category-tree';

/**
 * The read behind the public category tree: every platform category of the Market (any status,
 * so a merged or archived ancestor can be followed), with the names of the published revision
 * of each active one. Runs in the caller's read-only unit through the Market-scoped client;
 * never a seller category. Reads at most `limit` rows (the caller refuses a larger tree).
 */
export interface CategoryTreeReader {
  nodes(market: MarketContext, limit: number): Promise<readonly StoredCategoryNode[]>;
}

export const CATEGORY_TREE_READER = Symbol('CATEGORY_TREE_READER');
