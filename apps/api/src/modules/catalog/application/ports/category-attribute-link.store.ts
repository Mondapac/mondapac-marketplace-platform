import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { CategoryAttributeLink, LinkFact } from '../../domain/category-attribute-link';
import type { CategoryStatus } from '../../domain/platform-category';

/** One category's current link as the resolution reads it. */
export interface StoredLinkFact extends LinkFact {
  readonly categoryId: Id<'Category'>;
}

/**
 * The store behind a category's feature set and filter list (attributes package A4, categories
 * C8). Every method runs in the open unit of the use case through the Market-scoped client.
 * Nothing is deleted: a change is a new insert-only revision and the root's pointer moves to it.
 * A write whose link changed since it was read throws `StaleAggregateError`.
 */
export interface CategoryAttributeLinkStore {
  /** The link of this category, built from its current revision, or null when it has none. */
  find(market: MarketContext, categoryId: Id<'Category'>): Promise<CategoryAttributeLink | null>;

  /** The current link of every category that has one, at most `limit` (the caller refuses more). */
  all(market: MarketContext, limit: number): Promise<readonly StoredLinkFact[]>;

  /** The status of a platform category of this Market, or null when there is none. */
  categoryStatus(market: MarketContext, categoryId: Id<'Category'>): Promise<CategoryStatus | null>;

  /** Inserts the first link built by `CategoryAttributeLink.create`. */
  add(
    market: MarketContext,
    link: CategoryAttributeLink,
    authorAccountId: Id<'Account'>,
  ): Promise<void>;

  /** Inserts the revision built by `revise` and points the root at it behind its version. */
  saveRevision(
    market: MarketContext,
    link: CategoryAttributeLink,
    authorAccountId: Id<'Account'>,
  ): Promise<void>;
}

export const CATEGORY_ATTRIBUTE_LINK_STORE = Symbol('CATEGORY_ATTRIBUTE_LINK_STORE');
