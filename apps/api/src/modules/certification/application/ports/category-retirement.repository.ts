import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** A platform category named by a row of a published or pending policy revision. */
export interface PolicyNamedCategory {
  readonly categoryId: Id<'Category'>;
  /** A row on it has basis `NOT_APPLICABLE` or `SELLER_REQUIRED` (its lapse could relax a claim). */
  readonly relaxingRowNamed: boolean;
}

/**
 * The policy rows that name platform categories `catalog` wants to retire (design 3.7; B2;
 * ADR-0028 d5, d9; data design A12). "Named" means: a row of the policy's published revision, or
 * of the revision a `pending` `claim-policy-revision` relaxation proposal would publish.
 */
export interface CategoryRetirementRepository {
  /**
   * The codes, sorted and distinct, of the types whose published or pending policy revision has
   * a `NOT_APPLICABLE` or `SELLER_REQUIRED` row on one of the ids. Empty: nothing blocks. Opens a
   * read-only unit of its own; a fault rejects (the caller answers `unavailable`).
   */
  blockingTypeCodes(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
  ): Promise<readonly string[]>;

  /**
   * Inside the caller's read-write unit: the ids among `categoryIds` that a row of a published or
   * pending revision names, each once, with whether a relaxing row is among them.
   */
  namedCategories(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
  ): Promise<readonly PolicyNamedCategory[]>;

  /**
   * Inside the caller's read-write unit: inserts a flag per id, ignoring one that exists
   * (`retired_category_flags`, PK `(market_id, category_id)`), and answers the ids it inserted.
   */
  insertFlags(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
    reportedAt: Temporal.Instant,
  ): Promise<readonly Id<'Category'>[]>;
}
