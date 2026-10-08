import type { MarketContext } from '@mondapac/shared-kernel';
import type { CategoryName } from '../../domain/platform-category';

/** One category of a checked-in seed; a parent is named by its slug and listed before it. */
export interface SeededCategory {
  readonly slug: string;
  readonly parentSlug: string | null;
  readonly verticalRootCode: string | null;
  readonly names: readonly CategoryName[];
}

/**
 * The versioned seed of the platform category tree per Market (catalog design 7.2). A Market
 * with no seed file gets an empty list: its tree stays empty until the editor (slice 21).
 */
export interface CategorySeed {
  tree(market: MarketContext): readonly SeededCategory[];
}

export const CATEGORY_SEED = Symbol('CATEGORY_SEED');
