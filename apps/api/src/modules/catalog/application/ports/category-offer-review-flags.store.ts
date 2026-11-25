import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  CategoryOfferReviewFlag,
  CategoryOfferReviewFlags,
  FlaggedCategory,
} from '../../domain/category-offer-review-flags';

/** One row of the insert-only change log (`catalog.category_offer_review_changes`). */
export interface CategoryOfferReviewChangeEntry {
  readonly id: Id<'CategoryOfferReviewChange'>;
  readonly categoryId: Id<'Category'>;
  readonly flag: CategoryOfferReviewFlag;
  readonly previous: boolean;
  readonly next: boolean;
  /** Trimmed, 1 to 500 characters. Admin text: never logged. */
  readonly reason: string;
  readonly by: Id<'Account'>;
  readonly at: Temporal.Instant;
}

/** A flagged category as the admin list shows it. */
export interface FlaggedCategoryView extends FlaggedCategory {
  readonly version: number;
  readonly alwaysReviewChangedAt: Temporal.Instant | null;
  readonly reviewStopChangedAt: Temporal.Instant | null;
}

/**
 * The Offer review flags of platform categories (`catalog.category_offer_review_flags` and its
 * change log; slice 4) and the reads of the review facts. Every method runs in the caller's unit
 * through the Market-scoped client.
 */
export interface CategoryOfferReviewFlagsStore {
  /** True when the platform category exists in the Market (any status). */
  categoryExists(market: MarketContext, categoryId: Id<'Category'>): Promise<boolean>;

  /** The category's flags; `CategoryOfferReviewFlags.none` (version 0) when it has no row. */
  find(market: MarketContext, categoryId: Id<'Category'>): Promise<CategoryOfferReviewFlags>;

  /**
   * Writes the flags: inserts the row at version 1 when `expectedVersion` is 0, else one UPDATE
   * where the version is `expectedVersion`, raising it by one. False when no row matched (or the
   * row was created meanwhile): another change won.
   */
  save(
    market: MarketContext,
    flags: CategoryOfferReviewFlags,
    expectedVersion: number,
  ): Promise<boolean>;

  /** Appends one change to the insert-only log. */
  appendChange(market: MarketContext, entry: CategoryOfferReviewChangeEntry): Promise<void>;

  /** Every category of the Market with a flag on (tiny; no partial index on purpose). */
  listFlagged(market: MarketContext): Promise<readonly FlaggedCategoryView[]>;

  /**
   * The categories of the product's PUBLISHED revision (primary and others), or an empty list when
   * the product is unknown or has no published revision. Never a draft.
   */
  publishedCategoryIds(market: MarketContext, productId: Id<'Product'>): Promise<readonly string[]>;
}

export const CATEGORY_OFFER_REVIEW_FLAGS_STORE = Symbol(
  'CATALOG_CATEGORY_OFFER_REVIEW_FLAGS_STORE',
);
