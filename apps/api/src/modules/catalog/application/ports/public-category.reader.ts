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
   * The categories a published, not paused product with at least one listed Offer is on, in its
   * published revision (directly; the caller folds the subtree). At most `limit` ids.
   */
  withLiveProducts(market: MarketContext, limit: number): Promise<ReadonlySet<Id<'Category'>>>;
  /** The category that most recently retired `slug`, or null. */
  slugHistory(market: MarketContext, slug: string): Promise<Id<'Category'> | null>;
}

export const PUBLIC_CATEGORY_READER = Symbol('PUBLIC_CATEGORY_READER');
