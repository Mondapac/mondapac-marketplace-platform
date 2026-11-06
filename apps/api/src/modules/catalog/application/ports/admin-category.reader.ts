import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AdminStoredCategory, CategoryProductFact } from '../../domain/category-admin-tree';
import type { CategorySeo, CategoryText } from '../../domain/category-edit';
import type { CategoryName } from '../../domain/platform-category';

/** One revision of a category, newest first in {@link AdminCategoryReader.revisions}. */
export interface AdminCategoryRevisionRecord {
  readonly revisionNo: number;
  /** created | renamed | moved | merged | archived (C2 adds more kinds). */
  readonly changeKind: string;
  readonly authorKind: 'seed' | 'admin';
  /** Null exactly when the author is the seed. */
  readonly authorAccountId: Id<'Account'> | null;
  readonly parentId: Id<'Category'> | null;
  readonly names: readonly CategoryName[];
  readonly createdAt: Temporal.Instant;
}

/** What the edit form of one category needs beyond its names: the whole text and the flags. */
export interface AdminCategoryDetailRecord {
  readonly texts: readonly CategoryText[];
  readonly seo: CategorySeo;
  readonly showInMenu: boolean;
  readonly imageId: string | null;
  /** The category whose Hide cascaded to this one; null when hidden on its own or not hidden. */
  readonly hiddenById: Id<'Category'> | null;
}

/** The facts the counts are built from, and whether the read finished inside its time bound. */
export interface CategoryProductFacts {
  readonly facts: readonly CategoryProductFact[];
  /** False when the time bound ran out first: the counts are then "at least". */
  readonly complete: boolean;
}

/**
 * The reads behind the admin category pages (categories package C1), all in a read-only unit and
 * scoped to the request's Market: another Market's category is simply not found.
 */
export interface AdminCategoryReader {
  /** Every category of the Market in any status, at most `limit` (the caller refuses more). */
  categories(market: MarketContext, limit: number): Promise<readonly AdminStoredCategory[]>;

  /** The version of the Market's tree (`category_trees.version`); 0 when the row is missing. */
  treeVersion(market: MarketContext): Promise<number>;

  /**
   * One fact per published product of the Market (status `published`, paused or not). Reads in
   * pages and stops when `budgetMs` has passed, then answers `complete: false` with what it has.
   */
  productFacts(market: MarketContext, budgetMs: number): Promise<CategoryProductFacts>;

  /** The current texts and flags of one category; null for an unknown id. */
  detail(market: MarketContext, id: Id<'Category'>): Promise<AdminCategoryDetailRecord | null>;

  /** The revisions of one category, newest first, at most `limit`. Empty for an unknown id. */
  revisions(
    market: MarketContext,
    id: Id<'Category'>,
    limit: number,
  ): Promise<readonly AdminCategoryRevisionRecord[]>;
}

export const ADMIN_CATEGORY_READER = Symbol('ADMIN_CATEGORY_READER');
