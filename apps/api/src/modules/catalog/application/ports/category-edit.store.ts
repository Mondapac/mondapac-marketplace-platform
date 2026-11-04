import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { CategorySeo, CategoryText, EditableCategory } from '../../domain/category-edit';
import type { CategoryStatus } from '../../domain/platform-category';

/** What changed on a category, for the revision's `change_kind` (C2 vocabulary). */
export type CategoryChangeKind =
  'details-changed' | 'reordered' | 'hidden' | 'shown' | 'slug-changed' | 'discarded';

/** The root-row fields one change may set; a field left out keeps its value. */
export interface CategoryPatch {
  readonly status?: CategoryStatus;
  readonly hiddenById?: Id<'Category'> | null;
  readonly position?: number;
  readonly showInMenu?: boolean;
  readonly imageId?: string | null;
  readonly seo?: CategorySeo;
  readonly slug?: string;
}

/** A new category: created hidden, last among its siblings (plan decision 5). */
export interface NewCategory {
  readonly id: Id<'Category'>;
  readonly revisionId: Id<'CategoryRevision'>;
  readonly parentId: Id<'Category'> | null;
  readonly slug: string;
  readonly texts: readonly CategoryText[];
  readonly seo: CategorySeo;
  readonly showInMenu: boolean;
  readonly authorAccountId: Id<'Account'>;
  readonly now: Temporal.Instant;
}

/** One new revision of an existing category and the root-row change that goes with it. */
export interface CategoryChange {
  readonly category: EditableCategory;
  readonly revisionId: Id<'CategoryRevision'>;
  readonly kind: CategoryChangeKind;
  /** The full texts of the new revision (a copy of the current ones when only the state moved). */
  readonly texts: readonly CategoryText[];
  readonly patch: CategoryPatch;
  readonly authorAccountId: Id<'Account'>;
  readonly now: Temporal.Instant;
}

/**
 * The write side of the category tree editor (categories package C3a), behind the open unit of
 * the use case and the Market-scoped client. Revisions are insert-only: a change writes a new
 * revision (texts, then names) and moves the root's pointer, guarded by the root's version.
 */
export interface CategoryEditStore {
  /** Every category of the Market in any status with its current texts, at most `limit`. */
  loadAll(market: MarketContext, limit: number): Promise<readonly EditableCategory[]>;

  /**
   * Takes the transaction lock of each slug (`catalog.lock-category-slug`), in sorted order so two
   * units naming the same pair cannot wait for each other. Call it before `slugUnavailable`.
   */
  lockSlugs(market: MarketContext, slugs: readonly string[]): Promise<void>;

  /** Whether a slug is the current slug of a category, or was retired from another one < 12 months ago. */
  slugUnavailable(
    market: MarketContext,
    slug: string,
    exceptId: Id<'Category'> | null,
    now: Temporal.Instant,
  ): Promise<boolean>;

  /** Whether the category was ever shown (a `shown` revision exists), and how many product revisions name it. */
  discardFacts(
    market: MarketContext,
    id: Id<'Category'>,
  ): Promise<{ readonly everShown: boolean; readonly productRevisions: number }>;

  /** Inserts a hidden category with revision 1; returns its version (1). */
  insert(market: MarketContext, category: NewCategory): Promise<void>;

  /**
   * Writes the revision and the root change. Throws `StaleAggregateError` when the category's
   * version is no longer the one in `change.category`. Returns the new version.
   */
  apply(market: MarketContext, change: CategoryChange): Promise<number>;

  /** Records the slug a category stopped using (it redirects to the category; 12-month hold). */
  retireSlug(
    market: MarketContext,
    id: Id<'Category'>,
    slug: string,
    at: Temporal.Instant,
  ): Promise<void>;

  /**
   * Swaps the positions of two siblings (no gap, no clash): the first goes to a parking value,
   * the second to the first's place, the first to the second's. Writes no revision.
   */
  swapPositions(market: MarketContext, a: EditableCategory, b: EditableCategory): Promise<void>;
}

export const CATEGORY_EDIT_STORE = Symbol('CATEGORY_EDIT_STORE');
