import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PublicCategoryDetails } from '../../domain/public-category';

/**
 * The reads behind the buyer site's category tree and slug resolver (categories C6a), beside
 * {@link CategoryTreeReader}. Each runs in the caller's read-only unit through the Market-scoped
 * client and reads platform categories of that Market only.
 */
export interface PublicCategoryReader {
  /** The menu switch, the SEO fields and the published short descriptions of active categories. */
  details(
    market: MarketContext,
    limit: number,
  ): Promise<ReadonlyMap<Id<'Category'>, PublicCategoryDetails>>;
  /**
   * Per category, the number of published, not paused products with at least one listed Offer
   * that are on it in their published revision (directly; the caller folds the subtree). Only
   * categories with one or more; at most `limit` categories.
   */
  liveProductCounts(
    market: MarketContext,
    limit: number,
  ): Promise<ReadonlyMap<Id<'Category'>, number>>;
  /** The category that most recently retired `slug`, or null. */
  slugHistory(market: MarketContext, slug: string): Promise<Id<'Category'> | null>;
}

export const PUBLIC_CATEGORY_READER = Symbol('PUBLIC_CATEGORY_READER');
