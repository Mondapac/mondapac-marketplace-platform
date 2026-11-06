import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { CategorySeo, CategoryText, EditableCategory } from '../../domain/category-edit';
import type { CategoryStatus } from '../../domain/platform-category';

/** What changed on a category, for the revision's `change_kind` (C2 vocabulary). */
export type CategoryChangeKind =
  | 'details-changed'
  | 'reordered'
  | 'hidden'
  | 'shown'
  | 'slug-changed'
  | 'discarded'
  | 'moved'
  | 'merged'
  | 'archived';

/** The root-row fields one change may set; a field left out keeps its value. */
export interface CategoryPatch {
  readonly status?: CategoryStatus;
  readonly hiddenById?: Id<'Category'> | null;
  readonly position?: number;
  readonly showInMenu?: boolean;
  readonly imageId?: string | null;
  readonly seo?: CategorySeo;
  readonly slug?: string;
  /** A move (C4a): the new parent, recorded on the revision too. */
  readonly parentId?: Id<'Category'> | null;
  /** A merge (C4a): the category this one now resolves to; set with status `merged`. */
  readonly mergedIntoId?: Id<'Category'>;
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
  /** The admin's reason note of a move, merge or archive (10 to 500 characters), else absent. */
  readonly reason?: string;
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

/**
 * The product facts of a move, merge or archive (categories package C4a), read inside the use
 * case's unit. "Published product" means a product in status `published` and the categories of its
 * published revision: what the claim path reads.
 */
export interface CategoryRestructureStore {
  /** Per id, the published products whose published revision names it (ids with none left out). */
  directProducts(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
  ): Promise<ReadonlyMap<string, number>>;

  /**
   * The published products whose published revision names one of `categoryIds`, in product id
   * order, at most `limit`: per product, the other platform categories (any status) the revision
   * names. An archive reads it for the products it would leave with no live category (catalog
   * design AC 4) and for the ancestors they leave (Hassan M1, #712).
   */
  otherCategoriesOf(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
    limit: number,
  ): Promise<readonly (readonly Id<'Category'>[])[]>;

  /**
   * The published products whose published revision names one of the ids, in id order, at most
   * `limit`; and the `active` certification tags of their Offers (not deleted), which a change
   * marks `rechecking` (M1).
   */
  productsUnder(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
    limit: number,
  ): Promise<{
    readonly products: readonly {
      readonly productId: Id<'Product'>;
      readonly revisionId: Id<'ProductRevision'>;
    }[];
    readonly activeTags: number;
  }>;

  /**
   * Business activities (sellers' shop types): a merge links every activity of `from` to `to`
   * (insert ignoring a link that exists) and removes the links of `from`; an archive (`to` null)
   * removes them. Answers the number of activities that named `from`.
   */
  relinkActivities(
    market: MarketContext,
    from: Id<'Category'>,
    to: Id<'Category'> | null,
    now: Temporal.Instant,
  ): Promise<number>;
}

export const CATEGORY_RESTRUCTURE_STORE = Symbol('CATEGORY_RESTRUCTURE_STORE');

export const CATEGORY_EDIT_STORE = Symbol('CATEGORY_EDIT_STORE');
